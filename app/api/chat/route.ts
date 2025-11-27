import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { MODEL } from "@/config";
import { SYSTEM_PROMPT } from "@/prompts";
import { isContentFlagged } from "@/lib/moderation";
import { webSearch } from "./tools/web-search";
import { vectorDatabaseSearch } from "./tools/search-vector-database";
import {
  fetchStockAnalysis,
  fetchIndianStockFundamentals,
} from "@/lib/stocks";

export const maxDuration = 30;

type CountryMode = "US" | "IN" | null;

// Extract plain text from a UIMessage
function getText(msg: UIMessage): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
}

// Read past messages to see if user already chose a market
function detectCountry(messages: UIMessage[]): CountryMode {
  let country: CountryMode = null;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const t = getText(msg).toLowerCase();

    if (t.includes("us stocks") || t === "us" || t === "usa")
      country = "US";
    else if (t.includes("indian stocks") || t.includes("india"))
      country = "IN";
  }

  return country;
}

// Simple check for US-style symbols
function looksLikeSymbol(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 1 || t.length > 20) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9.]+$/.test(t);
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const latestUserMessage = messages.filter((m) => m.role === "user").pop();

  let latest = "";
  if (latestUserMessage) latest = getText(latestUserMessage);

  // Moderation check
  if (latest) {
    const mod = await isContentFlagged(latest);
    if (mod.flagged) {
      const stream = createUIMessageStream({
        execute({ writer }) {
          const id = "mod-deny";

          writer.write({ type: "start" });
          writer.write({ type: "text-start", id });
          writer.write({
            type: "text-delta",
            id,
            delta:
              mod.denialMessage ||
              "Your message violates our guidelines. I can't answer that.",
          });
          writer.write({ type: "text-end", id });
          writer.write({ type: "finish" });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }
  }

  const lower = latest.toLowerCase();
  const countryMode = detectCountry(messages);

  let usData: any = null;
  let inData: any = null;

  let analysisCountry: CountryMode = null;
  let askCountryClarify = false;
  let forceAskFirstQuestion = false;

  // --------------------------------------------
  // STEP 1: Force first question “Indian or US?”
  // --------------------------------------------

  if (!countryMode) {
    const isGreeting =
      !lower ||
      lower === "hi" ||
      lower === "hello" ||
      lower === "hey" ||
      lower.includes("help") ||
      lower.includes("analyse") ||
      lower.includes("analyze") ||
      lower.includes("research") ||
      lower.includes("stock");

    if (isGreeting) {
      forceAskFirstQuestion = true;
    }
  }

  // --------------------------------------------
  // STEP 2: Detect market selection
  // --------------------------------------------

  const isUsSelection =
    lower === "us" ||
    lower === "usa" ||
    lower.includes("us stocks");

  const isIndiaSelection =
    lower === "india" ||
    lower.includes("indian stocks");

  const isCountrySelection = isUsSelection || isIndiaSelection;

  // --------------------------------------------
  // STEP 3: Stock analysis path
  // --------------------------------------------

  if (!isCountrySelection) {
    // Case A: US mode active → expect US-style symbol
    if (countryMode === "US" && looksLikeSymbol(latest)) {
      analysisCountry = "US";
      try {
        usData = await fetchStockAnalysis(latest);
      } catch (err) {
        console.error("US data fetch error", err);
      }
    }

    // Case B: India mode active → accept symbol OR company name
    else if (countryMode === "IN" && latest.length > 1) {
      analysisCountry = "IN";
      try {
        inData = fetchIndianStockFundamentals(latest);
      } catch (err) {
        console.error("Indian fetch error", err);
      }
    }

    // Case C: No country chosen and user typed a symbol
    else if (!countryMode && looksLikeSymbol(latest)) {
      askCountryClarify = true;
    }
  }

  // --------------------------------------------
  // STEP 4: Build system prompt
  // --------------------------------------------

  let systemPrompt = SYSTEM_PROMPT;

  // 4A: US analysis
  if (analysisCountry === "US" && usData) {
    systemPrompt +=
      "\n\nThe user is analysing a US stock.\nHere is the data in JSON:\n" +
      JSON.stringify(usData);
  }

  // 4B: Indian analysis
  if (analysisCountry === "IN") {
    if (inData) {
      systemPrompt +=
        "\n\nThe user is analysing an Indian stock from the NIFTY 500 list.\n" +
        "Here is the data in JSON:\n" +
        JSON.stringify(inData);
    } else if (countryMode === "IN") {
      systemPrompt +=
        "\n\nThe user asked for an Indian stock that is NOT in the NIFTY 500 CSV.\n" +
        "Politely ask them to choose another NIFTY 500 stock.";
    }
  }

  // 4C: User typed stock but no country chosen
  if (askCountryClarify) {
    systemPrompt +=
      "\n\nThe user typed something that looks like a stock symbol, but they have not chosen Indian or US.\n" +
      "Ask them which market the stock belongs to.";
  }

  // 4D: User chose country
  if (isCountrySelection) {
    systemPrompt +=
      "\n\nThe user has chosen a market. Acknowledge briefly and ask them to type the stock symbol or name.";
  }

  // 4E: First message in conversation
  if (forceAskFirstQuestion) {
    systemPrompt +=
      "\n\nThis is the first message in the conversation and the user has NOT chosen a market.\n" +
      "Ask ONLY this question:\n" +
      "\"Hello, Welcome to Stock Unlock. Do you want to research Indian stocks or US stocks?\"\n" +
      "Do NOT analyse any stock yet.";
  }

  // --------------------------------------------
  // STEP 5: Call model
  // --------------------------------------------

  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools: { webSearch, vectorDatabaseSearch },
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: {
        reasoningSummary: "auto",
        reasoningEffort: "low",
        parallelToolCalls: false,
      },
    },
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
