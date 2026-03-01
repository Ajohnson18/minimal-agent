import { afterAll, describe, expect, test, vi } from "vitest";

import { db } from "../../../src/db/client.js";
import { avaUserIdentities, avaUsers } from "../../../src/db/schema/users.js";
import { eq } from "drizzle-orm";
import { isTestDatabaseReady, uniqueId } from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: user + credential flows", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await db.delete(avaUserIdentities).where(eq(avaUserIdentities.userId, userId));
      await db.delete(avaUsers).where(eq(avaUsers.id, userId));
    }
  });

  test("resolve/link/unlink identities and role assignment", async () => {
    process.env.AVA_OWNER_SLACK_ID = uniqueId("owner-slack");
    vi.resetModules();
    const userService = await import("../../../src/services/user.service.js");

    const owner = await userService.resolveUser("slack", process.env.AVA_OWNER_SLACK_ID!, "Owner User");
    createdUserIds.push(owner.id);
    expect(owner.role).toBe("owner");

    const member = await userService.resolveUser(
      "slack",
      uniqueId("member-slack"),
      "Member User",
    );
    createdUserIds.push(member.id);
    expect(["member", "owner"]).toContain(member.role);

    await userService.linkIdentity(member.id, "github", "gh-123", {
      team: "core",
    });

    const identities = await userService.getUserIdentities(member.id);
    expect(
      identities.some((identity) => identity.provider === "github" && identity.externalId === "gh-123"),
    ).toBe(true);

    const removed = await userService.unlinkIdentity(member.id, "github", "gh-123");
    expect(removed).toBe(true);
  });

  test("encrypts/decrypts user credentials and manages custom keys", async () => {
    vi.resetModules();
    const userService = await import("../../../src/services/user.service.js");

    const user = await userService.resolveUser("slack", uniqueId("cred-slack"), "Cred User");
    createdUserIds.push(user.id);

    await userService.setUserCredentials(user.id, {
      custom: [
        { key: "api_token", value: "secret-token" },
      ],
    });

    const creds = await userService.getUserCredentials(user.id);
    expect(creds?.custom?.[0].key).toBe("api_token");
    expect(creds?.custom?.[0].value).toBe("secret-token");

    await userService.setCredentialKey(user.id, "region", "us-central1");
    const keys = await userService.listCredentialKeys(user.id);
    expect(keys).toContain("api_token");
    expect(keys).toContain("region");

    const deleted = await userService.deleteCredentialKey(user.id, "region");
    expect(deleted).toBe(true);

    const keysAfterDelete = await userService.listCredentialKeys(user.id);
    expect(keysAfterDelete).not.toContain("region");
  });
});
