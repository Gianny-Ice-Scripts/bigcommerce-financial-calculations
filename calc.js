const fs = require("fs");
const readline = require("readline");
const Stripe = require("stripe");
const Table = require("cli-table3");
const path = require("path");

// File to store previous inputs
const CONFIG_FILE = path.join(__dirname, ".stripe-calculator-config.json");

// Function to load previous inputs
function loadPreviousInputs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.log("Could not load previous inputs. Using defaults.");
  }
  return {};
}

// Function to save inputs for next time
function saveInputs(inputs) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(inputs, null, 2));
    console.log(`✓ Settings saved for next time.\n`);
  } catch (error) {
    console.log("Could not save inputs for next time:", error.message);
  }
}

// Function to ask questions interactively with default values
async function askQuestion(query, defaultValue = "") {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Show default value if available
  const displayQuery = defaultValue
    ? `${query} (press Enter to use "${defaultValue}"): `
    : `${query}: `;

  return new Promise((resolve) => {
    rl.question(displayQuery, (answer) => {
      rl.close();
      // Use default if user just presses Enter
      resolve(answer.trim() || defaultValue);
    });
  });
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
  console.log("\n===== STRIPE FEE CALCULATOR =====");
  console.log(
    "This script calculates BigCommerce sales by excluding non-BigCommerce customers and ammo products."
  );
  console.log("Please provide the following information to get started.\n");

  // Load previous inputs
  const previousInputs = loadPreviousInputs();

  // ===== STEP 1: COLLECT USER INPUTS =====
  console.log("===== STEP 1: COLLECTING REQUIRED INPUTS =====");

  // Get Stripe API key and initialize
  const stripeSecretKey = await askQuestion(
    "Enter your Stripe secret key",
    previousInputs.stripeSecretKey || ""
  );
  const stripe = Stripe(stripeSecretKey);
  console.log("✓ Stripe connection established.\n");

  // Get ammo product ID to exclude
  const ammoProductId = await askQuestion(
    "Enter the Ammo product ID to exclude",
    previousInputs.ammoProductId || ""
  );
  console.log(`✓ Will exclude ammo product with ID: ${ammoProductId}\n`);

  // Get CSV file path
  const csvFilePath = await askQuestion(
    "Enter path to your Stripe Report CSV file",
    previousInputs.csvFilePath || ""
  );
  console.log(`✓ Will read data from: ${csvFilePath}\n`);

  // Get non-BigCommerce customer IDs (no default for this one)
  const nonBigCommerceIdsInput = await askQuestion(
    "Enter comma-separated customer IDs for NON-BigCommerce customers: "
  );
  const nonBigCommerceIds = nonBigCommerceIdsInput
    .split(",")
    .map((id) => id.trim());
  console.log(
    `✓ Will exclude ${nonBigCommerceIds.length} non-BigCommerce customers from calculation.\n`
  );

  // Save inputs for next time (except customer IDs)
  saveInputs({
    stripeSecretKey,
    ammoProductId,
    csvFilePath,
  });

  // ===== STEP 2: READ AND PARSE CSV DATA =====
  console.log("===== STEP 2: READING STRIPE DATA =====");

  // Initialize accounting variables
  let allTransactionsGross = 0.0; // Gross for all transactions
  let allTransactionsFees = 0.0; // Fees for all transactions
  let nonBigCommerceGross = 0.0; // Gross for non-BigCommerce customers
  let nonBigCommerceFees = 0.0; // Fees for non-BigCommerce customers
  let ammoProductsTotal = 0.0; // Total amount from ammo products
  let netBalanceChange = 0.0; // Net balance change from all activity

  // Create a more detailed transaction summary table with better labels
  const transactionTable = new Table({
    head: ["Transaction Source", "Gross Amount ($)", "Stripe Fee ($)", "Notes"],
    colWidths: [24, 15, 15, 20],
  });

  try {
    // Read and parse CSV file
    console.log(`Reading CSV from: ${csvFilePath}`);
    const csvData = fs.readFileSync(csvFilePath, "utf8");
    console.log("✓ File read successfully.");

    console.log("\nParsing transaction data...");
    process.stdout.write("Processing: ");
    const transactions = parseCSV(csvData);
    console.log(
      `\n✓ Found ${transactions.length} transactions in the CSV file.\n`
    );

    // ===== STEP 3: CALCULATE INITIAL TOTALS =====
    console.log("===== STEP 3: CALCULATING OVERALL TOTALS =====");

    // Calculate gross amount before fees
    console.log("Calculating gross amount for all transactions...");
    transactions.forEach((transaction) => {
      if (transaction["reporting_category"] === "charge") {
        const grossAmount = parseFloat(transaction["gross"]) || 0;
        allTransactionsGross += grossAmount;
      }

      // Track negative gross values for net balance calculation
      const grossValue = parseFloat(transaction["gross"]) || 0;
      if (grossValue < 0) {
        netBalanceChange += grossValue;
      }
    });
    console.log(
      `✓ Total gross (all transactions): $${allTransactionsGross.toFixed(2)}`
    );

    // Calculate total fees
    console.log("\nCalculating total fees from all transactions...");
    transactions.forEach((transaction) => {
      const feeValue = parseFloat(transaction["fee"]) || 0;
      allTransactionsFees -= feeValue; // Fees are negative in CSV, we negate to get positive
    });
    console.log(
      `✓ Total fees (all transactions): $${allTransactionsFees.toFixed(2)}`
    );

    // Calculate net balance change
    netBalanceChange =
      allTransactionsGross + netBalanceChange + allTransactionsFees;
    console.log(
      `✓ Net balance change from all activity: $${netBalanceChange.toFixed(
        2
      )}\n`
    );

    // ===== STEP 4: PROCESS INDIVIDUAL TRANSACTIONS =====
    console.log("===== STEP 4: PROCESSING INDIVIDUAL TRANSACTIONS =====");
    console.log("Processing each transaction to identify:");
    console.log("- Non-BigCommerce customers (from your input list)");
    console.log("- Transactions containing ammo products");
    console.log("- Transactions to exclude based on email filtering\n");

    // Counters for summary statistics
    let stats = {
      total: 0,
      skippedEmails: 0,
      nonBigCommerce: 0,
      containsAmmo: 0,
      noCustomerId: 0,
    };

    // Process each transaction
    console.log("Processing transactions: ");
    for (const transaction of transactions) {
      process.stdout.write(".");
      stats.total++;
      if (stats.total % 50 === 0) process.stdout.write(`[${stats.total}]`);

      const customerId = transaction["customer_id"];
      const customerEmail = transaction["customer_email"];
      const grossValue = parseFloat(transaction["gross"]) || 0;
      const feeValue = parseFloat(transaction["fee"]) || 0;

      // Skip transactions with filtered emails
      if (shouldIgnoreCustomer(customerEmail)) {
        stats.skippedEmails++;
        console.log(
          `\n→ Skipping: ${customerEmail} (ID: ${customerId}) - email filtered`
        );
        continue;
      }

      // Handle transactions without customer ID (e.g., Stripe fees)
      if (!customerId) {
        stats.noCustomerId++;
        nonBigCommerceGross += grossValue;
        nonBigCommerceFees += feeValue;
        transactionTable.push([
          "Stripe Fee/Adjustment", // More descriptive name
          grossValue.toFixed(2),
          feeValue.toFixed(2),
          grossValue < 0 ? "Fee/Refund" : "Payment", // Indicate transaction type
        ]);
      }
      // Handle non-BigCommerce customer transactions
      else if (nonBigCommerceIds.includes(customerId)) {
        stats.nonBigCommerce++;

        // For non-BigCommerce customers, include ALL products (including ammo)
        // No need to check for ammo products here
        nonBigCommerceGross += grossValue;
        nonBigCommerceFees += feeValue;

        transactionTable.push([
          `Customer: ${customerId.substring(0, 10)}...`, // Truncate long IDs
          grossValue.toFixed(2),
          feeValue.toFixed(2),
          "Non-BigCommerce", // Clearly indicate this is a non-BigCommerce transaction
        ]);
      }
      // BigCommerce customers are not processed here - they're calculated by subtraction
    }

    // Add subtotals by category
    const customerGross = nonBigCommerceIds.reduce(
      (sum, id) =>
        sum +
        transactions
          .filter((t) => t.customer_id === id)
          .reduce((s, t) => s + (parseFloat(t.gross) || 0), 0),
      0
    );

    const stripeFeesGross = nonBigCommerceGross - customerGross;

    // Add category subtotals to the table
    transactionTable.push([
      "SUBTOTAL: Customer",
      customerGross.toFixed(2),
      "—",
      `${nonBigCommerceIds.length} customers`,
    ]);

    transactionTable.push([
      "SUBTOTAL: Stripe Fees",
      stripeFeesGross.toFixed(2),
      "—",
      `${stats.noCustomerId} entries`,
    ]);

    // Add a clearer total row
    transactionTable.push([
      "NON-BIGCOMMERCE TOTAL",
      nonBigCommerceGross.toFixed(2),
      nonBigCommerceFees.toFixed(2),
      "Excluded from BC",
    ]);

    // ===== STEP 5: DISPLAY TRANSACTION SUMMARY =====
    console.log("\n\n===== STEP 5: TRANSACTION PROCESSING SUMMARY =====");
    console.log(`Total transactions processed: ${stats.total}`);
    console.log(
      `Transactions skipped due to email filtering: ${stats.skippedEmails}`
    );
    console.log(
      `Non-BigCommerce customer transactions: ${stats.nonBigCommerce}`
    );
    console.log(`Transactions containing ammo products: ${stats.containsAmmo}`);
    console.log(`Transactions without customer ID: ${stats.noCustomerId}`);

    // Display detailed transaction breakdown with a clearer header
    console.log(
      "\n===== NON-BIGCOMMERCE TRANSACTIONS (EXCLUDED FROM BIGCOMMERCE TOTALS) ====="
    );
    console.log(
      "The following transactions are NOT counted in BigCommerce sales:"
    );
    console.log(transactionTable.toString());

    // ===== STEP 6: CALCULATE BIGCOMMERCE VALUES =====
    console.log("\n===== STEP 6: CALCULATING BIGCOMMERCE VALUES =====");

    // Initial BigCommerce calculation (before ammo adjustment)
    let bigCommerceGross = allTransactionsGross - nonBigCommerceGross;
    console.log(
      `Initial BigCommerce gross (before ammo adjustment): $${bigCommerceGross.toFixed(
        2
      )}`
    );

    // Then in STEP 6 when calculating BigCommerce values, only exclude ammo for BigCommerce customers
    console.log(
      "\nFinding and excluding ammo products from BigCommerce customers only..."
    );
    let ammoInvoicesFound = 0;

    for (const transaction of transactions) {
      const customerId = transaction["customer_id"];
      const customerEmail = transaction["customer_email"];

      // Skip filtered emails and non-BigCommerce customers
      if (
        shouldIgnoreCustomer(customerEmail) ||
        nonBigCommerceIds.includes(customerId)
      ) {
        continue;
      }

      // Process BigCommerce customers only
      if (customerId) {
        const invoices = await stripe.invoices.list({
          customer: customerId,
          limit: 1,
        });

        if (invoices.data.length > 0) {
          const invoice = invoices.data[0];
          if (
            invoice.lines.data.some(
              (line) => line.price.product === ammoProductId
            )
          ) {
            ammoInvoicesFound++;

            invoice.lines.data.forEach((line) => {
              if (line.price.product === ammoProductId) {
                const ammoAmount = line.amount / 100; // Convert cents to dollars
                ammoProductsTotal += ammoAmount;
                bigCommerceGross -= ammoAmount;

                console.log(
                  `  → Excluding ammo: BigCommerce customer ${customerId}, $${ammoAmount.toFixed(
                    2
                  )}`
                );
              }
            });
          }
        }
      }
    }

    // Final BigCommerce calculations after all adjustments
    console.log(
      `\n✓ Found ${ammoInvoicesFound} BigCommerce invoices with ammo products`
    );
    console.log(
      `✓ Total amount from excluded ammo products: $${ammoProductsTotal.toFixed(
        2
      )}`
    );
    console.log(
      `✓ Final BigCommerce gross sales: $${bigCommerceGross.toFixed(2)}`
    );

    // Calculate BigCommerce net amount
    const bigCommerceNet =
      netBalanceChange - nonBigCommerceGross - nonBigCommerceFees;
    console.log(`✓ BigCommerce net disbursed: $${bigCommerceNet.toFixed(2)}`);

    // ===== STEP 7: DISPLAY CALCULATION DETAILS =====
    console.log("\n===== CALCULATION EXPLANATION =====");

    console.log("1. NON-BIGCOMMERCE GROSS BREAKDOWN:");
    console.log(
      `   • Direct customer transactions:  $${customerGross.toFixed(2)}`
    );
    console.log(
      `   • Stripe fees & adjustments:     $${stripeFeesGross.toFixed(2)}`
    );
    console.log(
      `   = Total Non-BigCommerce Gross:   $${nonBigCommerceGross.toFixed(2)}`
    );

    console.log("\n2. BIGCOMMERCE GROSS SALES CALCULATION:");
    console.log(
      `   • All transactions gross:        $${allTransactionsGross.toFixed(2)}`
    );
    console.log(
      `   • MINUS Non-BigCommerce gross:   $${nonBigCommerceGross.toFixed(2)}`
    );
    console.log(
      `   • MINUS Ammo products:           $${ammoProductsTotal.toFixed(2)}`
    );
    console.log(
      `   = BigCommerce Gross Sales:       $${bigCommerceGross.toFixed(2)}`
    );

    console.log("\n3. BIGCOMMERCE NET DISBURSED CALCULATION:");
    console.log(
      `   • Net balance from all activity: $${netBalanceChange.toFixed(2)}`
    );
    console.log(
      `   • MINUS Non-BigCommerce gross:   $${nonBigCommerceGross.toFixed(2)}`
    );
    console.log(
      `   • MINUS Non-BigCommerce fees:    $${nonBigCommerceFees.toFixed(2)}`
    );
    console.log(
      `   = BigCommerce Net Disbursed:     $${bigCommerceNet.toFixed(2)}`
    );

    // ===== STEP 8: FINAL RESULTS =====
    console.log("\n===== FINAL RESULTS =====");
    console.log(`BigCommerce Gross Sales = $${bigCommerceGross.toFixed(2)}`);
    console.log(`BigCommerce Net Disbursed = $${bigCommerceNet.toFixed(2)}`);
  } catch (err) {
    console.error("\n===== ERROR =====");
    console.error("Error processing the CSV file:", err);
    console.error("Please check your inputs and try again.");
  }
}

main();
