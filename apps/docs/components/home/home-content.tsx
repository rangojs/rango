import Link from "@/components/link";
import { StorefrontHero } from "@/components/storefront-hero";
import { Button } from "@/components/ui/button";
import {
  CommandPromptContent,
  CommandPromptCopy,
  CommandPromptList,
  CommandPromptPrefix,
  CommandPromptRoot,
  CommandPromptSurface,
  CommandPromptTrigger,
  CommandPromptTriggerDivider,
  CommandPromptViewport,
} from "@/components/ui/command-prompt";
import { homeSubtitle, homeTitle } from "@/lib/site";

import { AgentDemo } from "./agent-demo";
import { AssistantDemo } from "./assistant-demo";
import { CartDemo } from "./cart-demo";
import { CenteredSection } from "./centered-section";
import { ContentNegotiationDemo } from "./content-negotiation-demo";
import { CTA } from "./cta";
import { Hero } from "./hero";
import { LogosMarquee } from "./logos-marquee";
import { OneTwoSection } from "./one-two-section";
import { ShopifyCommerce } from "./shopify-commerce";

export function HomeContent() {
  return (
    <div className="container mx-auto max-w-[1448px]">
      <Hero
        badge="Vercel Shop is now in alpha"
        description={homeSubtitle}
        title={homeTitle}
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="h-12 w-fit rounded-full px-5">
            <Link href="https://template.vercel.shop/" target="_blank">
              Go to Demo
            </Link>
          </Button>
          <Button
            asChild
            className="h-12 w-fit rounded-full px-5"
            variant="secondary"
          >
            <Link href="/docs">View Documentation</Link>
          </Button>
        </div>
      </Hero>
      <div className="mx-auto grid max-w-[1080px] px-6 xl:px-0">
        <CenteredSection
          aside={
            <CommandPromptRoot defaultValue="humans">
              <CommandPromptList>
                <CommandPromptTrigger className="min-w-[90px]" value="humans">
                  For humans
                </CommandPromptTrigger>
                <CommandPromptTriggerDivider />
                <CommandPromptTrigger className="min-w-[84px]" value="agents">
                  For agents
                </CommandPromptTrigger>
              </CommandPromptList>
              <CommandPromptSurface>
                <CommandPromptPrefix>$</CommandPromptPrefix>
                <CommandPromptViewport>
                  <CommandPromptContent value="humans">
                    npx create-vercel-shop@latest
                  </CommandPromptContent>
                  <CommandPromptContent value="agents">
                    npx plugins add vercel/shop
                  </CommandPromptContent>
                </CommandPromptViewport>
                <CommandPromptCopy />
              </CommandPromptSurface>
            </CommandPromptRoot>
          }
          description="Cache Components serve product data instantly while streaming in personalized content."
          title="Dynamic at the speed of static"
        >
          <StorefrontHero />
        </CenteredSection>
        <ShopifyCommerce />
        <OneTwoSection
          description="The vercel-shop plugin and template recipes let agents extend your store with a single command. Add markets, CMS, auth, and more."
          leftClassName="xl:pt-[52px]"
          title="Agentic development"
        >
          <AgentDemo />
        </OneTwoSection>
        <OneTwoSection
          description="Built-in shopping assistant for your store powered by the AI SDK and AI Gateway."
          title="Shopping assistant"
        >
          <AssistantDemo />
        </OneTwoSection>
        <OneTwoSection
          description="Optimistic UI means the cart updates before the server responds. No spinners, no delays."
          title="Instant cart updates"
        >
          <CartDemo />
        </OneTwoSection>
        <OneTwoSection
          description="Serve structured content from your storefront to AI agents via Accept header, so agents can find, understand, and purchase your products."
          title="Content negotiation"
        >
          <ContentNegotiationDemo />
        </OneTwoSection>
        <LogosMarquee />
        <CTA
          className="mt-12 sm:mt-32"
          description="Fully customizable with AI agents. Built on Rango."
          primary={{
            href: "https://vercel.com/contact/sales",
            label: "Talk to an expert",
            target: "_blank",
          }}
          secondary={{
            href: "https://template.vercel.shop/",
            label: "Go to Demo",
            target: "_blank",
          }}
          title="Start your shop today."
        />
      </div>
    </div>
  );
}
