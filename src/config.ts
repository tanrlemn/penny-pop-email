export const config = {
  sequence: {
    apiUrl: 'https://api.getsequence.io/accounts',
  },
  classification: {
    // Names of accounts/pods that count toward your Savings Total.
    savingsNames: ['Safety Net', 'Move to ___', 'SoFi Savings'],
    // Not used for calculations (since savings is an allow-list), but kept for clarity.
    ignoreNames: [
      'Robinhood Spending',
      'SoFi Checking',
      'TANR LLC - Business Checking',
    ],
  },
  thresholds: {
    lookbackDays: 7,
    flatBandDollars: 25,
    redDownDollarsOverLookback: 150,
  },
  alerts: {
    redCooldownDays: 2,
    lookbackSearchWindowDays: 3,
  },
  cadence: {
    // Reserved for future notification policy tuning.
    // For now, email cadence is controlled purely by GitHub Actions cron.
  },
  email: {
    to: process.env.EMAIL_TO!,
    // Prefer Gmail identity for all outbound mail; fall back for legacy SMTP setups.
    from: (process.env.GMAIL_USER_EMAIL ?? process.env.EMAIL_FROM ?? process.env.SMTP_USER)!,
  },
};
