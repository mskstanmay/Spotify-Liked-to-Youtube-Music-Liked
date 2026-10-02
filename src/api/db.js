const { PrismaClient } = require('@prisma/client');

let prisma;

function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient({
      // Prisma's default error rendering can include connection details and
      // breaks the preflight command's machine-readable JSON contract.
      log: process.env.DEBUG_DB === 'true' ? ['warn', 'error'] : [],
    });
  }
  return prisma;
}

module.exports = { getPrisma };
