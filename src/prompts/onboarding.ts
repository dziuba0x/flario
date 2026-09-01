// MCP prompts: the hand extended to a developer who has just heard of Flare.
//
// Tools answer questions. Prompts teach someone what to ask in the first place.
// A developer who installs Flario and opens the prompt list should be able to
// go from "I've heard Flare has an oracle" to "I just verified a price against
// consensus on my own machine" without reading a single doc page.
//
// Every prompt below is written so the model runs real tools against the live
// network and then explains what actually happened, rather than lecturing from
// memory. Where Flare differs from what a developer expects from other chains,
// the prompt says so explicitly.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type PromptResult = {
  messages: Array<{
    role: "user";
    content: { type: "text"; text: string };
  }>;
};

function userPrompt(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const NETWORK_ARG = z
  .string()
  .optional()
  .describe("mainnet (default), coston2, songbird or coston");

export function registerOnboardingPrompts(server: McpServer): void {
  // ---------------------------------------------------------------------
  // 1. The front door. Zero arguments, zero prior knowledge assumed.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "flare_tour",
    {
      title: "Show me what Flare can do",
      description:
        "A guided, hands-on tour of Flare through live calls: a price feed, the same price carrying a Merkle proof you verify locally, and the state of FAssets. Start here if you are new to Flare.",
      argsSchema: { network: NETWORK_ARG },
    },
    ({ network }): PromptResult =>
      userPrompt(
        `Give me a hands-on tour of what Flare Network can do, using the Flario tools against ${network ?? "mainnet"}. Run the calls for real, do not describe them hypothetically.

Do it in this order, and after each step say in one or two plain sentences what just happened and why it matters:

1. Call get_ftso_feeds_all and show me a handful of live prices. Point out that these come from the chain's own enshrined oracle, not from a contract someone deployed on top of it.

2. Call get_ftso_anchor_feed for FLR/USD. This is the important one. Explain that the "verified: true" in the response was NOT the server's opinion: the tool pulled the Merkle proof, folded it locally, and compared the result against Relay.merkleRoots(100, round) read straight off the chain. Tell me what that means practically: I could throw away Flario and every Flare API and still check this number myself.

3. Call get_fassets_status for FXRP. Explain what FAssets is in one paragraph: real BTC/XRP/DOGE brought onto Flare with agent collateral, not a wrapped token backed by a company.

4. Call songbird_fcc_registry and tell me honestly what it reports today. If FCC contracts are not live yet, say so plainly rather than dressing it up.

Finish with a short, honest summary of what is genuinely different about Flare compared to a chain where the oracle is a contract someone deployed, and one concrete idea for what I could build with this. No hype, no marketing adjectives.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 2. The core idea, in one exercise: a fact you can check without trusting
  //    whoever handed it to you.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "verify_a_price",
    {
      title: "Verify a price without trusting anyone",
      description:
        "Fetch an FTSO price twice, once as a plain read and once carrying a Merkle proof verified locally against the on-chain root, and explain exactly what the difference buys you.",
      argsSchema: {
        feed: z
          .string()
          .optional()
          .describe('Feed name such as "FLR/USD", "BTC/USD" or "XRP/USD". Defaults to FLR/USD.'),
        network: NETWORK_ARG,
      },
    },
    ({ feed, network }): PromptResult =>
      userPrompt(
        `Using the Flario tools on ${network ?? "mainnet"}, show me the difference between reading a price and proving one, for the feed ${feed ?? "FLR/USD"}.

1. Call get_ftso_feed. This is the ordinary read: the chain's current value.

2. Call get_ftso_anchor_feed for the same feed. Show me the proof array, the voting round, and the Merkle root.

3. Now the part I actually care about. Walk me through what the tool did to earn "verified: true":
   - which leaf it built, and from which fields
   - how the proof was folded
   - which contract and which function it read the root from, on-chain
   - what would have happened if any of it had been tampered with

4. Then answer this directly: if Flario, the Flare data-availability API, and my RPC provider all lied to me at the same time, which of these two numbers would still be safe, and why?

5. Finally, tell me where this is genuinely useful and where it is overkill. If for most read-only dashboards the plain call is fine, say that.

Be concrete and use the real values you just got back. Do not hand-wave the cryptography.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 3. The flagship nobody knows about, including the trap in it.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "prove_a_web_fact",
    {
      title: "Turn a web API into a provable fact",
      description:
        "Use FDC Web2Json to make any public HTTP endpoint into something a smart contract can verify, and learn why binding the proof to an expected source is the whole game.",
      argsSchema: {
        url: z
          .string()
          .optional()
          .describe("Public HTTPS endpoint returning JSON. Defaults to a public example."),
        goal: z
          .string()
          .optional()
          .describe("What fact you want to prove, in plain words."),
      },
    },
    ({ url, goal }): PromptResult =>
      userPrompt(
        `I want to turn a fact from the public web into something a smart contract can verify, using Flare's Data Connector through Flario.

${url ? `Endpoint: ${url}` : "Pick a small, stable, public JSON endpoint as the example and tell me which one you chose."}
${goal ? `What I want to prove: ${goal}` : ""}

Walk me through it, running the tools for real:

1. Explain in three sentences what Web2Json is: the FDC attests that a given URL returned given data, and the result is verifiable on-chain.

2. Call fdc_web2json_request. Show me the jq filter and the ABI signature you chose, and explain why the shape has to be declared up front.

3. Before we go further, stop and explain the trap, because it is the part most people miss. A valid Merkle proof only proves that the data came from the URL embedded inside the proof. It does NOT prove that the URL is one I trust. An attacker with a valid proof from their own endpoint passes naive verification. Explain what fdc_verify_web2json's expect_source parameter does about that, and why the tool marks an unbound call source_bound: false with a warning.

4. Show me what a bound verification looks like and what error I get if the host does not match.

5. Give me two realistic things this makes possible that were not possible before, and one thing people will wrongly assume it guarantees.

Prioritise honesty over selling it. If a step needs a private key or an on-chain fee, say so plainly rather than glossing over it.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 4. A real job, not a demo.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "fassets_health_check",
    {
      title: "Check FAssets system health",
      description:
        "Read live FAssets state and agent collateral on Flare and summarise where the risk sits, using real numbers rather than a description of how FAssets works.",
      argsSchema: {
        asset: z.string().optional().describe("FXRP (default), FBTC or FDOGE."),
        network: NETWORK_ARG,
      },
    },
    ({ asset, network }): PromptResult =>
      userPrompt(
        `Give me a real health check of ${asset ?? "FXRP"} on ${network ?? "mainnet"} using the Flario tools. Numbers first, explanation second.

1. Call fassets_system_state: total minted, agent count, redemption queue.
2. Call fassets_agent_status and show me the agents with their collateral ratios.
3. For the agent with the thinnest margin, call fassets_agent_details.
4. If fassets_liquidation_scanner is available, run it: it cross-references agent collateral against live FTSO prices.

Then tell me, in plain language:
- how far prices would have to move before anything is actually at risk
- whether the system is concentrated in a few agents or spread out
- what a redemption queue that is empty, or not empty, is telling me

Be measured. If everything looks healthy and boring, say that instead of manufacturing concern. If the agent count is small enough that concentration is the real story, say that too.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 5. The thing you cannot do on a chain without an enshrined oracle.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "prove_what_you_acted_on",
    {
      title: "Prove what an agent acted on",
      description:
        "Bundle the facts behind a decision into something a third party can verify without trusting the agent, then try to forge it and watch the verification catch you.",
      argsSchema: {
        feeds: z
          .string()
          .optional()
          .describe('Comma-separated feed names, e.g. "FLR/USD,BTC/USD". Defaults to FLR/USD.'),
        network: NETWORK_ARG,
      },
    },
    ({ feeds, network }): PromptResult =>
      userPrompt(
        `Show me how an agent can prove which facts it acted on, using Flario against ${network ?? "mainnet"}. Run everything for real.

1. Call evidence_bundle with ftso_feeds ${feeds ? `[${feeds}]` : '["FLR/USD"]'} and a claim describing a decision those prices might support. Show me the bundle. Point out that each fact carries its own Merkle proof, its voting round, and the Relay address, and that a fact which failed verification would have been refused rather than included.

2. Call evidence_verify on that bundle unchanged. Explain that this did not trust the bundle, the agent that made it, or Flario: it rebuilt each leaf, folded it, and compared against Relay.merkleRoots read on-chain just now.

3. Now attack it. Take the bundle, change a price to something false, and verify again. It will fail with a specific reason.

4. Then attack it properly: change the price AND recompute bundle_hash so the hash check passes. Verify again. It still fails, and this is the interesting part — explain why bundle_hash was never the security boundary. The hash catches accidents. The Merkle fold against consensus catches attackers, because an attacker cannot produce a proof folding to a root the validators already signed.

5. Finally, be precise about what this does NOT prove: not that the agent was honest about its reasoning, not that these were the only facts it looked at, and not that its conclusion follows. Only that these specific facts were true, in these rounds. Say plainly why that narrower claim is still worth something.

Contrast it briefly with attesting that a server executed correctly, which is what most verifiable-tool-call work does — that approach still requires trusting the operator or their hardware.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 6. Watching a chain upgrade itself, live.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "watch_flare_2_rollout",
    {
      title: "Watch Flare 2.0 roll out",
      description:
        "Read the confidential-compute deployment straight off the chain — which networks have it, what it can do, what it is wired to — while the rollout is still in progress and before Flare has published an ABI.",
      argsSchema: {},
    },
    (): PromptResult =>
      userPrompt(
        `Show me where Flare 2.0's confidential compute actually stands right now, using Flario. Read the chain, do not summarise announcements.

1. Call fcc_deployment_status with network "all". Lead with the rollout front: which networks have a confidential-compute contract registered and which do not. That single line is the state of Flare 2.0 today.

2. For any network that has one, walk me through what was found:
   - is it an ERC-2535 diamond, how many facets, how many function selectors
   - which capabilities those selectors add up to, in plain language
   - what it is wired to, and whether FDC V2 has code at the address it points to
   - whether live_state shows real governance signers and machine-allowlist revisions, or an empty deployment

3. Explain why this tool reads selectors instead of calling functions. Flare has not published an ABI for these contracts — they are absent from the periphery artifacts, alpha included. Selectors are the routing table inside the diamond, so they are facts on-chain that survive a rename, while a tool built on guessed function signatures would break the moment Flare finalises the interface. Say clearly which parts of the report are exact and which came from signature matching.

4. Then tell me what it means. Protocol Managed Wallets mean keys that live inside an enclave rather than with a user. Machine attestation means the chain decides which code hashes and hardware are allowed to hold them. Enclave VRF means randomness nobody chose. Say which of these is genuinely new for a public chain and which is table stakes.

5. Finish honestly: this is a testnet deployment of an unfinished system, so anything here can change. Say what would have to happen for it to matter in production.`,
      ),
  );

  // ---------------------------------------------------------------------
  // 7. For the developer who wants the mental model before the code.
  // ---------------------------------------------------------------------
  server.registerPrompt(
    "why_flare_for_agents",
    {
      title: "Why Flare, for someone building agents",
      description:
        "The honest case for and against building agent infrastructure on Flare, grounded in live calls rather than the marketing site.",
      argsSchema: {},
    },
    (): PromptResult =>
      userPrompt(
        `I build AI agents. Make the case for and against Flare as the chain I reach for, and ground every claim in an actual Flario call rather than in what Flare's website says.

Cover:

1. What "enshrined" means here, precisely. FTSO and FDC are part of the protocol and secured by the validator set, not contracts someone deployed and could abandon. Demonstrate it: show me that Flario resolves every address at runtime through the ContractRegistry rather than hardcoding any of them, and explain why that matters for something that has to keep working unattended.

2. The thing that is genuinely hard to copy: an agent can hand a downstream consumer a fact plus a proof, and that consumer verifies it without trusting the agent, the server, or any API. Demonstrate it with get_ftso_anchor_feed. Contrast it with the more common approach of attesting that the *server executed correctly*, which still asks you to trust the server operator or its hardware.

3. Where Flare is weak or where I would be fighting the ecosystem. Liquidity, tooling maturity, developer mindshare, whatever is actually true. Do not soften it.

4. Call songbird_fcc_registry and tell me what is honestly live today versus announced.

5. End with a one-paragraph verdict: for which kind of agent is this the right chain, and for which kind is it clearly the wrong one.

I would rather hear a fair assessment that talks me out of it than a pitch.`,
      ),
  );
}
