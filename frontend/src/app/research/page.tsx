import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Research · AssetFlow",
  description:
    "Why tokenized assets need a servicing layer on Solana now: the September 2026 SEC actions, the market, the incumbents and where AssetFlow fits.",
};

/*
 * The market case behind AssetFlow, kept on the site so judges and partners
 * read it next to the product. English only: the Crypto World's Fair takes
 * submissions in English.
 */

const WHY_NOW = [
  {
    date: "1 Sep 2026",
    title: "The SEC proposes modernizing the transfer-agent rules",
    body: "A blockchain could serve as all or part of the master securityholder file, the official record of who owns what. Transfer agents using one would file new Form TA-2 reports. Comments close 3 November 2026.",
    href: "https://www.skadden.com/insights/publications/2026/09/sec-proposes-modernization-of-transfer-agent-rules",
    source: "Skadden",
  },
  {
    date: "23 Sep 2026",
    title: "A five-year SEC order lets tokenized stocks trade on public blockchains",
    body: "Every participant must be permissioned, at the pool or at the token itself. The token must carry the same dividends and votes as the share. Venues must publish who can pause, upgrade or override the contracts.",
    href: "https://solana.com/news/stocks-sec-innovation-exemption",
    source: "Solana Policy Institute",
  },
  {
    date: "Jul 2026",
    title: "Solana holds US$3.7 billion of tokenized real-world assets across 313,000 holders",
    body: "Treasuries, public equities, private credit and funds from BlackRock, Franklin Templeton, Apollo, Superstate and others, with permissioning done through Token-2022.",
    href: "https://solana.com/news/overview-of-institutional-real-world-assets-on-solana",
    source: "Solana",
  },
];

const LANDSCAPE = [
  {
    name: "Superstate FundOS",
    href: "https://superstate.com/fundos",
    offers: "Shareholder registers across chains, USD and USDC subscriptions and redemptions, allowlist. Coinbase Asset Management and Invesco use it.",
    gap: "A closed platform for large asset managers, bundled with Superstate's own transfer-agent services.",
  },
  {
    name: "Securitize",
    href: "https://www.theblock.co/post/399390/tokenize-world-securitize-computershare-to-bring-more-stocks-onchain",
    offers: "Vertically integrated: transfer agent, broker-dealer and trading venue; the technology behind Computershare's tokenized shares.",
    gap: "An all-in-one stack; issuers onboard through its regulated pipeline.",
  },
  {
    name: "Merkl",
    href: "https://blog.merkl.xyz/programmable-paying-agent-tokenized-finance",
    offers: "A programmable paying agent: coupons, dividends and yield routed to token holders.",
    gap: "EVM chains, plus Stellar since April 2026; no Solana support found as of this page.",
  },
  {
    name: "SettleMint, Kaleido",
    href: "https://www.settlemint.com/bond-tokenization",
    offers: "Enterprise platforms with bond lifecycle templates: coupons, dividends, redemptions.",
    gap: "Sold to large institutions, mostly on EVM or private networks.",
  },
  {
    name: "HashKey Tokenisation",
    href: "https://group.hashkey.com/en/hashkey-group-unveils-one-stop-rwa-solution-to-support-the-positioning-of-hong-kong-as-a-global-rwa-innovation-powerhouse/",
    offers: "A one-stop RWA issuance service in Hong Kong, on the ERC-3643 standard.",
    gap: "Full-service issuance for Hong Kong, not a servicing layer other issuers run themselves.",
  },
];

const DIFFERENCE = [
  {
    title: "Built on Solana's own permissioning standard",
    body: "Eligibility runs through Token ACL (sRFC-37), the Solana Foundation's program, with AssetFlow as its gate. That is the token-level permissioning the SEC order accepts, not a new token standard.",
  },
  {
    title: "The program computes what holders are owed",
    body: "Instrument terms live on-chain, the register is fixed on the record date, and each entitlement is computed by the program and paid in USDC. The operator never types an amount.",
  },
  {
    title: "Open and self-serve",
    body: "The programs, console and tests are MIT-licensed. An issuer sets up a registry and an asset in two signed transactions; a transfer agent can run it for its own clients.",
  },
  {
    title: "Checkable, not claimed",
    body: "Every guarantee is read back from the chain on the proof page, including who can pause and upgrade, which the SEC order asks venues to publish.",
  },
  {
    title: "One register, more than one chain",
    body: "The EVM contracts AssetFlow started as are live on HashKey Chain mainnet. Base, Arbitrum and Robinhood Chain are planned, with the same record-date payout published on each.",
  },
];

const RISKS = [
  {
    risk: "Token ACL's specification is not final, and AssetFlow's program is unaudited.",
    response: "Adversarial tests on every path around the gate today; an audit, a verifiable build and a multisig upgrade authority before any mainnet asset.",
  },
  {
    risk: "Regulation differs by market and keeps moving.",
    response: "AssetFlow is software, not a transfer agent: licensed firms stay responsible for their records. Mainland China is off by default.",
  },
  {
    risk: "Getting coupon amounts exactly right.",
    response: "Day count, rounding and record-date rules in the program itself, with tests on the edge cases: odd holdings, frozen holders, rounding dust.",
  },
];

const SOURCES = [
  ["SEC transfer-agent proposal (Skadden)", "https://www.skadden.com/insights/publications/2026/09/sec-proposes-modernization-of-transfer-agent-rules"],
  ["Stocks Go Onchain: the SEC's innovation exemption", "https://solana.com/news/stocks-sec-innovation-exemption"],
  ["Overview of institutional real-world assets on Solana", "https://solana.com/news/overview-of-institutional-real-world-assets-on-solana"],
  ["Tokenized RWAs at US$34.18B (Binance Research, 15 Sep 2026)", "https://en.cryptonomist.ch/2026/09/22/tokenized-real-world-assets-activation/"],
  ["Superstate FundOS", "https://superstate.com/fundos"],
  ["Computershare and Securitize partnership", "https://www.theblock.co/post/399390/tokenize-world-securitize-computershare-to-bring-more-stocks-onchain"],
  ["Merkl: the programmable paying agent", "https://blog.merkl.xyz/programmable-paying-agent-tokenized-finance"],
  ["Merkl goes non-EVM, starting with Stellar", "https://blog.merkl.xyz/merkl-goes-non-evm-starting-with-stellar"],
  ["Hong Kong SFC tokenised products framework, April 2026", "https://www.charlesrussellspeechlys.com/en/insights/expert-insights/financial-services/2026/hong-kong-sfc-launches-new-framework-for-secondary-trading-of-tokenised-investment-products/"],
  ["Tokenization platform fees, 2026", "https://tokenizestartup.com/platforms/tokenization-platform-fees/"],
  ["Token ACL (sRFC-37)", "https://github.com/solana-foundation/token-acl"],
] as const;

export default function ResearchPage() {
  return (
    <article className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-sm font-semibold text-accent">Research · as of 28 September 2026</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        Tokenized assets on Solana need a servicing layer, and now a regulator says what it must do.
      </h1>
      <p className="mt-4 text-lg text-ink-2">
        Issuing a tokenized bond or fund on Solana is solved many times over. Running it afterwards is not: who may hold
        it, what each holder is owed on the record date, and how they redeem. AssetFlow is the open, Solana-native
        paying agent and register for that work, for licensed transfer agents and mid-market issuers. Eligibility,
        coupons, redemptions and maturity all run on devnet today.
      </p>

      <Section title="Why now">
        <ol className="grid gap-4">
          {WHY_NOW.map((w) => (
            <li key={w.title} className="card p-5">
              <p className="tabular text-sm font-semibold text-accent">{w.date}</p>
              <h3 className="mt-1 font-semibold">{w.title}</h3>
              <p className="mt-2 text-sm text-ink-2">{w.body}</p>
              <a className="mt-2 inline-block text-sm text-ink-3 underline underline-offset-2 hover:text-ink" href={w.href}>
                {w.source}
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-ink-2">
          Across all chains, tokenized real-world assets reached US$34.18 billion on 15 September 2026; bonds and money-market
          funds are US$18.29 billion of it.
        </p>
      </Section>

      <Section title="What has been built">
        <p className="text-ink-2">
          We searched the 5,428 projects submitted to Colosseum&apos;s Renaissance, Radar, Breakout and Cypherpunk hackathons
          with Colosseum Copilot. The prize-winning tokenized-asset projects originate assets or supply data: Autonom, an
          oracle that adjusts prices for corporate actions (1st, Cypherpunk RWA track), and asset originators such as
          Pencil Finance and Watchtower. None services an asset after issuance, and no Colosseum accelerator company does,
          as far as the corpus shows. Live products tell the same story: The Grid lists 64 tokenization platforms from 55
          companies on Solana, almost all of them issuance.
        </p>
      </Section>

      <Section title="The landscape">
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-ink-2">
              <tr>
                <th className="px-4 py-3 font-medium">Player</th>
                <th className="px-4 py-3 font-medium">What it offers</th>
                <th className="px-4 py-3 font-medium">Where AssetFlow differs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line align-top">
              {LANDSCAPE.map((p) => (
                <tr key={p.name}>
                  <td className="px-4 py-3 font-medium">
                    <a className="underline underline-offset-2 hover:text-accent" href={p.href}>
                      {p.name}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-ink-2">{p.offers}</td>
                  <td className="px-4 py-3 text-ink-2">{p.gap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="How AssetFlow is different">
        <div className="grid gap-4 sm:grid-cols-2">
          {DIFFERENCE.map((d) => (
            <div key={d.title} className="card p-5">
              <h3 className="font-semibold">{d.title}</h3>
              <p className="mt-2 text-sm text-ink-2">{d.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Business model">
        <p className="text-ink-2">
          The programs and SDK stay free under MIT, with no on-chain fee. Revenue comes from the hosted console and servicing:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-2">
          <li>Console: US$399 a month for one asset and up to 500 holders; US$1,499 for ten assets and up to 10,000.</li>
          <li>Servicing: 3 basis points a year on assets serviced.</li>
          <li>Events: US$0.25 per holder per payout or redemption.</li>
        </ul>
        <p className="mt-3 text-ink-2">
          An issuer with US$25 million and 400 holders paid monthly comes to about US$13,500 a year, inside the
          US$5,000 to US$25,000 a year that digital transfer-agent services cost today, and far below the US$50,000 to
          US$100,000 upfront of full-service platforms.
        </p>
      </Section>

      <Section title="Risks">
        <div className="card divide-y divide-line">
          {RISKS.map((r) => (
            <div key={r.risk} className="grid gap-2 p-4 text-sm sm:grid-cols-2 sm:gap-6">
              <p className="font-medium">{r.risk}</p>
              <p className="text-ink-2">{r.response}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Sources">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {SOURCES.map(([label, href]) => (
            <li key={href}>
              <a className="text-accent underline underline-offset-2" href={href}>
                {label}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-3">
          Hackathon data from Colosseum Copilot; product data from The Grid. See the product itself on the{" "}
          <Link className="underline underline-offset-2" href="/proof">
            proof page
          </Link>
          .
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
