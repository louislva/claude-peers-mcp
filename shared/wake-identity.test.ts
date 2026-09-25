import { expect, test } from "bun:test";
import { wakeIdentityFromEnv } from "./wake-identity.ts";

test("a Claude desktop session is identified by its host session id",()=>{
 expect(wakeIdentityFromEnv({CLAUDE_CODE_HOST_SESSION_ID:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365",CLAUDE_CODE_SESSION_ID:"f1f6b49e-0070-471e-b278-077eb7f1c882"}))
  .toEqual({harness:"claude-desktop",host_session_id:"local_a7661a7f-932d-4a9a-aee7-eacd33e50365"});
});
test("a Codex task is identified by its thread id",()=>{
 expect(wakeIdentityFromEnv({CODEX_THREAD_ID:"01a0da28-f06c-7a62-b236-cf37ef228046"}))
  .toEqual({harness:"codex",host_session_id:"01a0da28-f06c-7a62-b236-cf37ef228046"});
});
test("a CLI or unattended session has no wake identity",()=>{
 expect(wakeIdentityFromEnv({CLAUDE_CODE_SESSION_ID:"f1f6b49e-0070-471e-b278-077eb7f1c882"})).toBeNull();
});
