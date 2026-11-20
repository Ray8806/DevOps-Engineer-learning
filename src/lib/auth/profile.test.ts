import { describe, expect, it } from "vitest";
import { accountInitial, accountLabel, providerLabel, toAccountUser } from "./profile";

describe("toAccountUser", () => {
  it("reads name and provider from a Google user", () => {
    const user = toAccountUser({
      id: "u1",
      email: "ray@example.com",
      user_metadata: { full_name: "Ray Chen", name: "Ray Chen", avatar_url: "https://x" },
      app_metadata: { provider: "google", providers: ["google"] },
    });
    expect(user).toEqual({ id: "u1", email: "ray@example.com", name: "Ray Chen", provider: "google" });
  });

  it("falls back to the GitHub user name", () => {
    const user = toAccountUser({ id: "u2", email: "a@b.c", user_metadata: { user_name: "octo" }, app_metadata: { provider: "github" } });
    expect(user.name).toBe("octo");
  });

  it("handles an email-link user without metadata", () => {
    const user = toAccountUser({ id: "u3", email: "me@example.com", app_metadata: { provider: "email" } });
    expect(user).toEqual({ id: "u3", email: "me@example.com", name: null, provider: "email" });
  });

  it("ignores blank and non-string values", () => {
    const user = toAccountUser({ id: "u4", email: "", user_metadata: { full_name: "  ", name: 42 }, app_metadata: null });
    expect(user).toEqual({ id: "u4", email: null, name: null, provider: null });
  });
});

describe("labels", () => {
  const base = { id: "x", email: null, name: null, provider: null };

  it("prefers the name, then the email", () => {
    expect(accountLabel({ ...base, name: "Ray", email: "r@e.com" })).toBe("Ray");
    expect(accountLabel({ ...base, email: "r@e.com" })).toBe("r@e.com");
    expect(accountLabel(base)).toBe("我的帳號");
  });

  it("uses the first character for the avatar", () => {
    expect(accountInitial({ ...base, name: "ray" })).toBe("R");
    expect(accountInitial({ ...base, name: "陳小明" })).toBe("陳");
    expect(accountInitial({ ...base, email: "me@example.com" })).toBe("M");
    expect(accountInitial(base)).toBe("?");
  });

  it("names the sign-in method", () => {
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("email")).toBe("Email 登入連結");
    expect(providerLabel(null)).toBeNull();
  });
});
