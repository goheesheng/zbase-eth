console.error(
  "This historical test used the removed server-side-secret and transaction-hash bearer flow. " +
    "Run `ZX402_ALLOW_DEVNET_WRITES=I_ACKNOWLEDGE_DEVNET_WRITES npm run test:svm-devnet` " +
    "from the repository root after the reviewed program upgrade.",
);
process.exitCode = 1;
