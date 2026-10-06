import assert from "node:assert/strict";
import test from "node:test";
import { loginPageState } from "../src/login-navigation.js";

test("verification and intermediate LinkedIn redirects remain interactive", () => {
  for (const url of [
    "https://www.linkedin.com/checkpoint/challenge/verify",
    "https://www.linkedin.com/checkpoint/lg/login-submit",
    "https://www.linkedin.com/checkpoint/lg/login-success",
    "https://www.linkedin.com/?trk=after-verification",
    "https://www.linkedin.com/home",
    "https://www.linkedin.com/login-submit",
    "https://www.linkedin.com/security-verification",
    "https://www.linkedin.com/sales/checkpoint",
    "https://www.linkedin.com/sales/login",
    "https://linkedin.com/uas/login",
    "https://www.linkedin.com/authwall?next=/feed/",
    "https://www.linkedin.com/feedback",
  ]) assert.equal(loginPageState(url), "interactive", url);
});

test("only known signed-in destinations finish the login window", () => {
  for (const url of [
    "https://www.linkedin.com/feed",
    "https://www.linkedin.com/feed/?trk=login",
    "https://www.linkedin.com/in/example/",
    "https://www.linkedin.com/sales/home",
    "https://www.linkedin.com/sales/search/people",
    "https://www.linkedin.com/sales/lead/example",
  ]) assert.equal(loginPageState(url), "complete", url);
});

test("credentials cannot be sent to lookalike or third-party origins", () => {
  for (const url of [
    "https://linkedin.com.evil.example/login",
    "https://evil-linkedin.com/login",
    "https://linkedin.com@evil.example/login",
    "https://evil.example@www.linkedin.com/login",
    "https://captcha.example/verify",
    "http://www.linkedin.com/login",
    "about:blank",
    "not a URL",
  ]) assert.equal(loginPageState(url), "external", url);
});
