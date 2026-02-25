import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const copyProfile = await prisma.copyProfile.upsert({
    where: {
      name_followerAddress: {
        name: "default",
        followerAddress: "0x0000000000000000000000000000000000000000"
      }
    },
    update: {
      status: "PAUSED"
    },
    create: {
      name: "default",
      followerAddress: "0x0000000000000000000000000000000000000000",
      status: "PAUSED",
      defaultRatio: "0.01",
      config: {
        seeded: true,
        note: "bootstrap profile"
      }
    }
  });

  const components = [
    "WORKER",
    "DATABASE",
    "REDIS",
    "ALCHEMY_WS",
    "WEB",
    "NGINX"
  ] as const;

  const defaultStatus = "DOWN" as const;

  for (const component of components) {
    await prisma.systemStatus.upsert({
      where: { component },
      update: {
        status: defaultStatus,
        details: {
          seeded: true,
          note: "initial status placeholder"
        }
      },
      create: {
        component,
        status: defaultStatus,
        details: {
          seeded: true,
          note: "initial status placeholder"
        }
      }
    });
  }

  await prisma.configAuditLog.create({
    data: {
      scope: "SYSTEM",
      scopeRefId: "seed",
      changedBy: "seed-script",
      changeType: "CREATED",
      nextValue: {
        copyProfileId: copyProfile.id,
        defaultRatio: copyProfile.defaultRatio.toString()
      },
      reason: "stage-3 bootstrap"
    }
  });

  console.log("[seed] bootstrap records created");
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
