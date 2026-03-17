require("dotenv").config();

const API_VERSION = process.env.API_VERSION || "2026-01";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const SOURCE_SHOP = process.env.SOURCE_SHOP;
const SOURCE_TOKEN = process.env.SOURCE_TOKEN;
const SOURCE_LOCATION_ID = process.env.SOURCE_LOCATION_ID;

const DEST_SHOP = process.env.DEST_SHOP;
const DEST_TOKEN = process.env.DEST_TOKEN;
const DEST_LOCATION_ID = process.env.DEST_LOCATION_ID;

function assertEnv() {
  const required = [
    "SOURCE_SHOP",
    "SOURCE_TOKEN",
    "SOURCE_LOCATION_ID",
    "DEST_SHOP",
    "DEST_TOKEN",
    "DEST_LOCATION_ID",
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing .env values: ${missing.join(", ")}`);
  }
}

async function shopifyGraphQL(shop, token, query, variables = {}) {
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${shop}: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${shop}: ${text}`);
  }

  if (json.errors) {
    throw new Error(`GraphQL errors from ${shop}: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function escapeSkuForQuery(sku) {
  return String(sku).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getAvailableQtyAtLocation(inventoryLevels, locationId) {
  const level = inventoryLevels.find((lvl) => lvl.location?.id === locationId);
  if (!level) return null;

  const available = level.quantities?.find((q) => q.name === "available");
  return available ? Number(available.quantity) : 0;
}

const GET_SOURCE_VARIANTS_PAGE = `
  query GetSourceVariantsPage($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, query: "sku:*") {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        title
        displayName
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
                name
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const FIND_DEST_VARIANT_BY_SKU = `
  query FindDestVariantBySku($query: String!) {
    productVariants(first: 5, query: $query) {
      nodes {
        id
        sku
        title
        displayName
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
                name
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const ACTIVATE_INVENTORY = `
  mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      inventoryLevel {
        id
        location {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_INVENTORY = `
  mutation SetInventory($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function fetchAllSourceVariants() {
  const all = [];
  let after = null;

  while (true) {
    const data = await shopifyGraphQL(
      SOURCE_SHOP,
      SOURCE_TOKEN,
      GET_SOURCE_VARIANTS_PAGE,
      { first: 250, after }
    );

    const connection = data.productVariants;
    all.push(...connection.nodes);

    console.log(`Fetched ${all.length} source variants...`);

    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return all;
}

async function findDestVariantBySku(sku) {
  const query = `sku:"${escapeSkuForQuery(sku)}"`;

  const data = await shopifyGraphQL(
    DEST_SHOP,
    DEST_TOKEN,
    FIND_DEST_VARIANT_BY_SKU,
    { query }
  );

  const exactMatches = data.productVariants.nodes.filter((v) => v.sku === sku);

  if (exactMatches.length === 0) return null;
  if (exactMatches.length > 1) {
    throw new Error(`Multiple exact matches in destination for SKU "${sku}"`);
  }

  return exactMatches[0];
}

async function ensureDestInventoryActive(inventoryItemId) {
  const data = await shopifyGraphQL(
    DEST_SHOP,
    DEST_TOKEN,
    ACTIVATE_INVENTORY,
    {
      inventoryItemId,
      locationId: DEST_LOCATION_ID,
    }
  );

  const errors = data.inventoryActivate.userErrors || [];
  if (errors.length) {
    throw new Error(
      `inventoryActivate failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }
}

async function setDestQuantity(inventoryItemId, quantity, compareQuantity = null) {
  const input = {
    name: "available",
    reason: "correction",
    ignoreCompareQuantity: compareQuantity === null,
    quantities: [
      {
        inventoryItemId,
        locationId: DEST_LOCATION_ID,
        quantity,
        ...(compareQuantity !== null ? { compareQuantity } : {}),
      },
    ],
  };

  const data = await shopifyGraphQL(DEST_SHOP, DEST_TOKEN, SET_INVENTORY, { input });

  const errors = data.inventorySetQuantities.userErrors || [];
  if (errors.length) {
    throw new Error(
      `inventorySetQuantities failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }
}

async function syncOne(sourceVariant) {
  const sku = (sourceVariant.sku || "").trim();
  if (!sku) {
    return { status: "skipped", reason: "blank-sku" };
  }

  const sourceItem = sourceVariant.inventoryItem;
  if (!sourceItem) {
    return { status: "skipped", sku, reason: "no-source-inventory-item" };
  }

  if (!sourceItem.tracked) {
    return { status: "skipped", sku, reason: "source-not-tracked" };
  }

  const sourceQty = getAvailableQtyAtLocation(
    sourceItem.inventoryLevels.nodes,
    SOURCE_LOCATION_ID
  );

  if (sourceQty === null) {
    return { status: "skipped", sku, reason: "source-location-not-found" };
  }

  const destVariant = await findDestVariantBySku(sku);
  if (!destVariant) {
    return { status: "missing", sku, sourceQty, reason: "not-found-in-dest" };
  }

  const destItem = destVariant.inventoryItem;
  if (!destItem) {
    return { status: "skipped", sku, reason: "no-dest-inventory-item" };
  }

  if (!destItem.tracked) {
    return { status: "skipped", sku, reason: "dest-not-tracked" };
  }

  let destQty = getAvailableQtyAtLocation(
    destItem.inventoryLevels.nodes,
    DEST_LOCATION_ID
  );

  if (destQty === null) {
    if (DRY_RUN) {
      return {
        status: "dry-run",
        sku,
        sourceQty,
        destQty: null,
        action: "activate-and-set",
      };
    }

    await ensureDestInventoryActive(destItem.id);

    const refreshedDest = await findDestVariantBySku(sku);
    destQty = getAvailableQtyAtLocation(
      refreshedDest.inventoryItem.inventoryLevels.nodes,
      DEST_LOCATION_ID
    );

    if (destQty === null) {
      destQty = 0;
    }
  }

  if (destQty === sourceQty) {
    return { status: "unchanged", sku, qty: sourceQty };
  }

  if (DRY_RUN) {
    return {
      status: "dry-run",
      sku,
      sourceQty,
      destQty,
      action: "set-quantity",
    };
  }

  await setDestQuantity(destItem.id, sourceQty, destQty);

  return {
    status: "updated",
    sku,
    from: destQty,
    to: sourceQty,
  };
}

async function main() {
  assertEnv();

  console.log(`API_VERSION=${API_VERSION}`);
  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log(`SOURCE_SHOP=${SOURCE_SHOP}`);
  console.log(`DEST_SHOP=${DEST_SHOP}`);
  console.log("");

  const sourceVariants = await fetchAllSourceVariants();
  console.log(`\nTotal source variants fetched: ${sourceVariants.length}\n`);

  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  let skipped = 0;
  let failed = 0;
  let dryRun = 0;

  const missingList = [];
  const failures = [];

  for (const variant of sourceVariants) {
    const sku = variant.sku || "(blank)";

    try {
      const result = await syncOne(variant);

      switch (result.status) {
        case "updated":
          updated++;
          console.log(`[UPDATED] SKU=${result.sku} ${result.from} -> ${result.to}`);
          break;

        case "unchanged":
          unchanged++;
          console.log(`[UNCHANGED] SKU=${result.sku} qty=${result.qty}`);
          break;

        case "missing":
          missing++;
          missingList.push(result);
          console.log(`[MISSING] SKU=${result.sku} sourceQty=${result.sourceQty}`);
          break;

        case "dry-run":
          dryRun++;
          console.log(
            `[DRY-RUN] SKU=${result.sku} action=${result.action} sourceQty=${result.sourceQty} destQty=${result.destQty}`
          );
          break;

        default:
          skipped++;
          console.log(`[SKIPPED] SKU=${sku} reason=${result.reason}`);
      }
    } catch (err) {
      failed++;
      failures.push({ sku, error: err.message });
      console.log(`[FAILED] SKU=${sku} error=${err.message}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Updated:   ${updated}`);
  console.log(`Dry-run:   ${dryRun}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Missing:   ${missing}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);

  if (missingList.length) {
    console.log("\n=== MISSING IN DEST STORE ===");
    for (const item of missingList) {
      console.log(`- SKU=${item.sku} sourceQty=${item.sourceQty}`);
    }
  }

  if (failures.length) {
    console.log("\n=== FAILURES ===");
    for (const item of failures) {
      console.log(`- SKU=${item.sku} error=${item.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});