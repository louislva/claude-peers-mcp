import { expect, test } from "bun:test";
import { esc, groupThreads, receiptTrack, wakeTrack, renderPage, type DashMessage } from "./dashboard-render.ts";

const m=(o:Partial<DashMessage>):DashMessage=>({id:1,from_id:"a",to_id:"b",text:"t",sent_at:"2026-09-25T20:00:00.000Z",offer_count:0,delivered:0,acknowledged_at:null,reply_to:null,root_id:null,hop:0,woken_at:null,wake_attempts:0,wake_error:null,...o});

test("agent text is rendered inert: tags, links and scripts are escaped",()=>{
 const html=renderPage({messages:[m({text:`<script>alert(1)</script><img src=x onerror=y><a href="http://evil">x</a>`})],peers:[{id:"a",online:1,summary:"<b>me</b>",last_seen:"2026-09-25T20:00:00.000Z"}],attempts:[],problems:[],filter:{},generatedAt:"2026-09-25T20:01:00.000Z"});
 expect(html).not.toContain("<script>alert");expect(html).not.toContain("<img src=x");expect(html).not.toContain('href="http://evil"');expect(html).not.toContain("<b>me</b>");
 expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
 expect(esc(`"'&`)).toBe("&quot;&#39;&amp;");
});
test("threads group by conversation root; legacy rows by participant pair; newest first",()=>{
 const g=groupThreads([m({id:1,root_id:1}),m({id:2,root_id:1,reply_to:1,from_id:"b",to_id:"a"}),m({id:3,from_id:"b",to_id:"a"}),m({id:4,from_id:"a",to_id:"b"})]);
 expect(g.map(t=>[t.key,t.messages.map(x=>x.id)])).toEqual([["pair:a↔b",[3,4]],["root:1",[1,2]]]);
});
test("receipt and wake are independent tracks",()=>{
 expect([receiptTrack(m({})),receiptTrack(m({offer_count:2})),receiptTrack(m({offer_count:1,delivered:1}))]).toEqual(["queued","offered×2","acked"]);
 expect([wakeTrack(m({})),wakeTrack(m({woken_at:1,wake_attempts:1})),wakeTrack(m({wake_attempts:3,wake_error:"x"}))]).toEqual(["—","rung (1 attempt)","failed ×3"]);
});
