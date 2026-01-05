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
    emailWeeklyOnDay: 1, // Sunday = 0
    alwaysEmailOnRed: true,
  },
  email: {
    to: process.env.EMAIL_TO!,
    from: process.env.EMAIL_FROM!,
  },
};
