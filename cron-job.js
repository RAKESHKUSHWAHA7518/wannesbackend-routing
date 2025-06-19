// schedule-tasks.js
const cron = require("node-cron");
const { generateMonthlyInvoices } = require("./invoice-service");

// Run at midnight on the 1st of every month
cron.schedule("0 0 1 * *", async () => {
  console.log("Running monthly invoice generation");
  try {
    await generateMonthlyInvoices();
    console.log("Monthly invoices generated successfully");
  } catch (error) {
    console.error("Error generating monthly invoices:", error);
  }
});

// Your invoice generation service
async function generateMonthlyInvoices() {
  // 1. Query your database for all active customers
  // 2. For each customer, get their usage amount for the month
  // 3. Generate invoice with that amount

  // Example pseudocode:
  const activeUsers = await db.users.findAll({ where: { active: true } });

  for (const user of activeUsers) {
    // Get the usage from your database
    const monthlyUsage = await db.usageStats.findOne({
      where: {
        userId: user.id,
        month: new Date().getMonth(),
        year: new Date().getFullYear(),
      },
    });

    if (monthlyUsage && monthlyUsage.amount > 0) {
      // Generate the invoice
      await generateInvoice(
        user.stripeCustomerId,
        monthlyUsage.amount,
        `Monthly service for ${new Date().toLocaleDateString("en-US", { month: "long" })}`,
      );
    }
  }
}
