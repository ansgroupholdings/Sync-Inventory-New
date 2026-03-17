require("dotenv").config()

const express = require("express")
const bodyParser = require("body-parser")

const app = express()
app.use(bodyParser.json())

const API_VERSION = "2026-01"

async function shopify(shop, token, query) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query })
  })

  return res.json()
}

async function findVariantBySku(shop, token, sku) {
  const query = `
  {
    productVariants(first:1, query:"sku:${sku}") {
      nodes {
        id
        sku
        inventoryItem { id }
      }
    }
  }
  `

  const data = await shopify(shop, token, query)

  return data.data.productVariants.nodes[0]
}

async function updateInventory(inventoryItemId, qty) {
  const mutation = `
  mutation {
    inventorySetQuantities(input:{
      name:"available"
      reason:"correction"
      ignoreCompareQuantity:true
      quantities:[
        {
          inventoryItemId:"${inventoryItemId}"
          locationId:"${process.env.DEST_LOCATION_ID}"
          quantity:${qty}
        }
      ]
    }) {
      userErrors { message }
    }
  }
  `

  const data = await shopify(process.env.DEST_SHOP, process.env.DEST_TOKEN, mutation)

  // Log the response from Shopify for debugging
  console.log("Inventory update response:", data);

  // Safely check if the response contains the data and userErrors
  if (data && data.inventorySetQuantities) {
    const userErrors = data.inventorySetQuantities.userErrors || []; // Default to an empty array if undefined

    if (userErrors.length > 0) {
      console.log("Error while updating inventory:", userErrors);
      return { success: false, error: userErrors };
    }

    // If no errors were found, log the success
    console.log("Inventory successfully synced.");
    return { success: true };
  } else {
    // If no inventorySetQuantities exists in the response
    console.error("No inventory data returned from Shopify");
    return { success: false, error: "No inventory data returned" };
  }
}

app.post("/webhook/inventory", async (req, res) => {
  try {
    const payload = req.body;

    // Log the incoming payload
    console.log("Received webhook payload:", JSON.stringify(payload, null, 2));

    const sku = payload.inventory_item.sku;
    const qty = payload.inventory_item.quantity;

    console.log("Inventory change:", sku, qty);

    // Find the variant in the destination store by SKU
    const destVariant = await findVariantBySku(
      process.env.DEST_SHOP,
      process.env.DEST_TOKEN,
      sku
    );

    if (!destVariant) {
      console.log("SKU not found in destination store:", sku);
      return res.sendStatus(200); // Continue with 200 OK if SKU not found
    }

    // Update the inventory in the destination store
    const updateResponse = await updateInventory(destVariant.inventoryItem.id, qty);

    // Log the response from Shopify API
    console.log("Inventory update response:", JSON.stringify(updateResponse, null, 2));

    // Check if Shopify returned any user errors during inventory update
    if (updateResponse.inventorySetQuantities.userErrors && updateResponse.inventorySetQuantities.userErrors.length > 0) {
      console.log("Error while updating inventory:", updateResponse.inventorySetQuantities.userErrors);
      return res.sendStatus(500); // Send 500 if there's an error
    }

    console.log("Inventory successfully synced:", sku);

    res.sendStatus(200); // Send 200 OK on success

  } catch (err) {
    console.error("Error processing webhook:", err);
    res.sendStatus(500); // Send 500 if there's an error
  }
});

// Route to check if the server is running
app.get("/", (req, res) => {
  res.send("Webhook server is running!");
});

// Start the server on port 3000
app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});