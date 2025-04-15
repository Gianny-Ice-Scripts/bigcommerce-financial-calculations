const fs = require("fs");
const readline = require("readline");
const Stripe = require("stripe");
const Table = require("cli-table3");

// Function to ask questions interactively
async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

// Function to parse CSV data and remove extra quotes
function parseCSV(data) {
  const lines = data.split("\n").filter((line) => line.trim() !== "");
  const headers = lines[0]
    .split(",")
    .map((header) => header.replace(/['"]+/g, ""));
  return lines.slice(1).map((line) => {
    const columns = line
      .split(",")
      .map((column) => column.replace(/['"]+/g, ""));
    let row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = columns[index] ? columns[index].trim() : "";
    });
    return row;
  });
}

// Function to calculate proportional fee for each product line in the invoice
function calculateProportionalFees(invoice, totalFee) {
  let feesPerProduct = {};
  let totalQuantity = invoice.lines.data.reduce(
    (sum, line) => sum + line.quantity,
    0
  );

  invoice.lines.data.forEach((line) => {
    const productId = line.price.product;
    const quantity = line.quantity;
    const proportion = quantity / totalQuantity;
    feesPerProduct[productId] =
      (feesPerProduct[productId] || 0) + totalFee * proportion;
  });

  return feesPerProduct;
}

// Function to check if email contains any of the filtered terms
function shouldIgnoreCustomer(email) {
  if (!email) return false;
  const lowerEmail = email.toLowerCase();
  return (
    lowerEmail.includes("razoyo") ||
    lowerEmail.includes("automaticffl") ||
    lowerEmail.includes("refactored.group")
  );
}

// Function to check if the payment contains the specified product and calculate fees
async function getProductFees(stripe, customerId, totalFee, ammoProductId) {
  try {
    if (!customerId) {
      console.error("Invalid customer ID");
      return { hasExcludedProduct: false, feesPerProduct: {} };
    }

    // Retrieve invoice data for the customer
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 1,
    });
    if (invoices.data.length === 0) {
      console.error(`No invoices found for customer ID ${customerId}`);
      return { hasExcludedProduct: false, feesPerProduct: {} };
    }
    const invoice = invoices.data[0];

    // Check if the invoice contains the specified product
    const hasExcludedProduct = invoice.lines.data.some(
      (item) => item.price.product === ammoProductId
    );

    // Calculate proportional fees per product line
    const feesPerProduct = calculateProportionalFees(invoice, totalFee);

    return { hasExcludedProduct, feesPerProduct, invoice };
  } catch (err) {
    console.error(
      `Error fetching payment details for customer ID ${customerId}:`,
      err
    );
  }
  return { hasExcludedProduct: false, feesPerProduct: {} };
}

async function main() {
  // Gather necessary inputs from the user
  const stripeSecretKey = await askQuestion(
    "Please enter your Stripe secret key: "
  );
  const stripe = Stripe(stripeSecretKey);

  const ammoProductId = await askQuestion(
    "Please enter the Ammo product ID to exclude: "
  );
  const csvFilePath = await askQuestion(
    "Where is your Stripe Report located? "
  );
  const customerIdsInput = await askQuestion(
    "Please paste your comma separated customer_ids here: "
  );
  const customerIds = customerIdsInput.split(",").map((id) => id.trim());

  // Initialize totals for gross sales and fees
  let totalGross = 0.0;
  let totalFee = 0.0;
  let grossAmountBeforeFees = 0.0;
  let netBalanceChange = 0.0;

  // Create a table to log data for better visualization
  const table = new Table({
    head: ["Customer ID", "Gross", "Fee", "Contains Ammo Product"],
    colWidths: [20, 15, 15, 20],
  });

  // Read and parse the CSV file
  try {
    const data = fs.readFileSync(csvFilePath, "utf8");
    console.log("CSV file read successfully.");
    process.stdout.write("Processing CSV data");
    const rows = parseCSV(data);
    console.log("CSV data parsed successfully.\n");
    console.log();

    // Calculate gross amount before fees and net balance change
    rows.forEach((row) => {
      if (row["reporting_category"] === "charge") {
        grossAmountBeforeFees += parseFloat(row["gross"]) || 0;
      }
      const grossValue = parseFloat(row["gross"]) || 0;
      if (grossValue < 0) {
        netBalanceChange += grossValue;
      }
    });

    // Calculate total fees from the CSV
    rows.forEach((row) => {
      const feeValue = parseFloat(row["fee"]) || 0;
      totalFee -= feeValue;
    });

    // Calculate net balance change from activity
    netBalanceChange = grossAmountBeforeFees + netBalanceChange + totalFee;

    // Log the gross amount before fees and net balance change
    console.log(
      `Gross Amount Before Fees: $${grossAmountBeforeFees.toFixed(2)}`
    );
    console.log(
      `Balance Change From Activity: $${netBalanceChange.toFixed(2)}`
    );

    // Process each row to calculate gross sales and fees, considering exclusions
    for (const row of rows) {
      process.stdout.write(".");
      const customerId = row["customer_id"];
      const customerEmail = row["customer_email"];
      const grossValue = parseFloat(row["gross"]) || 0;
      const feeValue = parseFloat(row["fee"]) || 0;

      // Skip customers with email containing 'razoyo' or 'automaticffl'
      if (shouldIgnoreCustomer(customerEmail)) {
        console.log(
          `\nSkipping customer ${customerEmail} with ID ${customerId} due to email filtering`
        );
        continue;
      }

      if (!customerId) {
        // Rows without customer ID: use values as is
        totalGross += grossValue;
        totalFee += feeValue;
        table.push([
          "Additional Stripe fees",
          grossValue.toFixed(2),
          feeValue.toFixed(2),
          "N/A",
        ]);
      } else if (customerIds.includes(customerId)) {
        // Rows with valid customer ID: check for excluded products
        totalFee += feeValue;
        const { hasExcludedProduct, feesPerProduct, invoice } =
          await getProductFees(stripe, customerId, feeValue, ammoProductId);
        if (!hasExcludedProduct) {
          // No excluded product in the invoice
          totalGross += grossValue;
          totalFee += feeValue;
          table.push([
            customerId,
            grossValue.toFixed(2),
            feeValue.toFixed(2),
            "No",
          ]);
        } else {
          // Excluded product found, adjust values accordingly
          invoice.lines.data.forEach((line) => {
            if (line.price.product !== ammoProductId) {
              totalGross += line.amount;
              totalFee += feesPerProduct[line.price.product] || 0;
              table.push([
                customerId,
                line.amount.toFixed(2),
                (feesPerProduct[line.price.product] || 0).toFixed(2),
                "Yes",
              ]);
            }
          });
        }
      }
    }

    // Add total row to the table
    table.push(["Total", totalGross.toFixed(2), totalFee.toFixed(2), ""]);

    // Log the table for visual summary
    console.log("\n");
    console.log(table.toString());

    // Calculate BigCommerce Gross Sales, excluding specified products
    let bigCommerceGrossSales = grossAmountBeforeFees - totalGross;
    for (const row of rows) {
      const customerId = row["customer_id"];
      const customerEmail = row["customer_email"];
      const grossValue = parseFloat(row["gross"]) || 0;

      // Skip customers with email containing 'razoyo' or 'automaticffl'
      if (shouldIgnoreCustomer(customerEmail)) {
        continue;
      }

      if (customerId && customerIds.includes(customerId)) {
        const invoices = await stripe.invoices.list({
          customer: customerId,
          limit: 1,
        });
        const invoice = invoices.data[0];
        if (
          invoice &&
          invoice.lines.data.some(
            (line) => line.price.product === ammoProductId
          )
        ) {
          invoice.lines.data.forEach((line) => {
            if (line.price.product === ammoProductId) {
              bigCommerceGrossSales -= line.amount;
            }
          });
        }
      }
    }
    const bigCommerceNetDisbursed = netBalanceChange - totalGross - totalFee;

    // Display the output
    console.log(
      `\nBigCommerce Gross Sales = $${bigCommerceGrossSales.toFixed(2)}`
    );
    console.log(
      `BigCommerce Net Disbursed = $${bigCommerceNetDisbursed.toFixed(2)}`
    );
  } catch (err) {
    console.error("Error reading the CSV file:", err);
  }
}

main();
