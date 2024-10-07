const fs = require('fs');
const readline = require('readline');

// Function to ask questions
async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
    }));
}

// Function to parse CSV data and remove extra quotes
function parseCSV(data) {
    const lines = data.split('\n').filter(line => line.trim() !== '');
    const headers = lines[0].split(',').map(header => header.replace(/['"]+/g, ''));
    return lines.slice(1).map(line => {
        const columns = line.split(',').map(column => column.replace(/['"]+/g, ''));
        let row = {};
        headers.forEach((header, index) => {
            row[header.trim()] = columns[index] ? columns[index].trim() : '';
        });
        return row;
    });
}

async function main() {
    // Ask for the location of the Stripe Report CSV file
    const csvFilePath = await askQuestion("Where is your Stripe Report located? ");

    // Ask for the comma separated list of payment IDs
    const paymentIdsInput = await askQuestion("Please paste your comma separated payment_ids here: ");
    const paymentIds = paymentIdsInput.split(',').map(id => id.trim());

    // Ask for the account activity before fees
    const accountActivityBeforeFees = parseFloat((await askQuestion("What is the Account activity before fees? $")).replace(/,/g, ''));

    // Ask for the net balance change
    const netBalanceChange = parseFloat((await askQuestion("What is the Net balance change? $")).replace(/,/g, ''));

    // Initialize total gross and total fee
    let totalGross = 0.0;
    let totalFee = 0.0;

    // Read and parse the CSV file
    try {
        const data = fs.readFileSync(csvFilePath, 'utf8');
        console.log('CSV file read successfully.');
        const rows = parseCSV(data);
        console.log('CSV data parsed successfully.');

        rows.forEach(row => {
            const customerId = row['customer_id'];
            const grossValue = parseFloat(row['gross']) || 0;
            const feeValue = parseFloat(row['fee']) || 0;

            if (paymentIds.includes(customerId)) {
                console.log(`Match found for customer_id: ${customerId}`);
                totalGross += grossValue;
                totalFee += feeValue;
                console.log(`Adding gross: ${grossValue}, fee: ${feeValue}`);
            }
        });

        console.log(`\nTotal Gross from CSV: $${totalGross.toFixed(2)}`);
        console.log(`Total Fee from CSV: $${totalFee.toFixed(2)}`);
        console.log(`Account activity before fees: $${accountActivityBeforeFees.toFixed(2)}`);
        console.log(`Net balance change: $${netBalanceChange.toFixed(2)}`);

        const bigCommerceGrossSales = accountActivityBeforeFees - totalGross;
        const bigCommerceNetDisbursed = netBalanceChange - totalGross - totalFee;

        // Display the output
        console.log(`\nBigCommerce Gross Sales = $${bigCommerceGrossSales.toFixed(2)}`);
        console.log(`BigCommerce Net Disbursed = $${bigCommerceNetDisbursed.toFixed(2)}`);

    } catch (err) {
        console.error('Error reading the CSV file:', err);
    }
}

main();
