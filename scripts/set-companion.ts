import "dotenv/config";
import { prisma } from "../lib/prisma";

async function main() {
  const email = process.argv[2];
  const name = process.argv[3];
  const relation = process.argv[4];
  if (!email || !name || !relation) {
    console.log("Usage: tsx scripts/set-companion.ts <email> <name> <relation>");
    process.exit(1);
  }
  const r = await prisma.user.update({
    where: { email },
    data: { companionName: name, companionRelation: relation },
    select: { email: true, companionName: true, companionRelation: true },
  });
  console.log(r);
  await prisma.$disconnect();
}
main().catch(console.error);
