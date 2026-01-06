type EmailPeriodicMode = "weekly" | "twiceDaily" | "always";

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
    // During testing we run this workflow twice per day; this controls the
    // "periodic summary" emails (which bypass baseline/missing-data suppression).
    //
    // GitHub Actions cron uses UTC; the default workflow is scheduled around
    // 00:13 and 12:13 UTC, so we use hours [0, 12] here.
    emailPeriodicMode: "twiceDaily" as EmailPeriodicMode,
    emailWeeklyOnDay: 1, // Sunday = 0 (used when emailPeriodicMode === "weekly")
    emailTwiceDailyHoursUtc: [0, 12], // used when emailPeriodicMode === "twiceDaily"
    alwaysEmailOnRed: true,
  },
  email: {
    to: process.env.EMAIL_TO!,
    from: process.env.EMAIL_FROM!,
  },
};
