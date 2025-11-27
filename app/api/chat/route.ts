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
  USStockData,
  IndiaStockFundamentals,
} from "@/lib/stocks";

export const maxDuration = 30;

type CountryMode = "US" | "IN" | null;

// ---------------- Helpers ----------------

function getText(msg: UIMessage): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
}

// Look only at user messages passed in
function detectCountry(messages: UIMessage[]): CountryMode {
  let mode: CountryMode = null;

  for (const msg of messages) {
    const t = getText(msg).toLowerCase();
    if (!t) continue;

    if (t === "us" || t === "usa" || t.includes("us stocks")) {
      mode = "US";
    } else if (
      t === "india" ||
      t.includes("indian stocks") ||
      t.includes("nifty")
    ) {
      mode = "IN";
    }
  }

  return mode;
}

// Strict US ticker pattern: uppercase letters/digits/dot, no spaces
function looksLikeUsSymbol(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 1 || t.length > 10) return false;
  if (/\s/.test(t)) return false;
  if (t !== t.toUpperCase()) return false; // must be uppercase
  return /^[A-Z0-9.]+$/.test(t);
}

// ---------------- Handler ----------------

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const userMessages = messages.filter((m) => m.role === "user");
  const latestUserMessage = userMessages[userMessages.length - 1];

  const latestText = latestUserMessage ? getText(latestUserMessage) : "";
  const lower = latestText.toLowerCase();

  // 1) Moderation
  if (latestText) {
    const mod = await isContentFlagged(latestText);
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

  // 2) Work out previous vs latest country selection
  const previousUserMessages = userMessages.slice(0, -1);
  const previousCountry = detectCountry(previousUserMessages);

  const isUsSelection =
    lower === "us" || lower === "usa" || lower.includes("us stocks");

  const isIndiaSelection =
    lower === "india" ||
    lower.includes("indian stocks") ||
    lower.includes("nifty");

  const selectedCountry: CountryMode = isUsSelection
    ? "US"
    : isIndiaSelection
    ? "IN"
    : null;

  const countryMode: CountryMode = selectedCountry ?? previousCountry;

  // 3) HARD RULE: if no country chosen yet and this message is NOT a selection,
  //    always ask them to choose Indian vs US and STOP here.
  if (!countryMode && !selectedCountry) {
    const stream = createUIMessageStream({
      execute({ writer }) {
        const id = "choose-market";
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id });
        writer.write({
          type: "text-delta",
          id,
          delta:
            "Hello, Welcome to Stock Unlock. Do you want to research **Indian stocks** or **US stocks**?",
        });
        writer.write({ type: "text-end", id });
        writer.write({ type: "finish" });
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  // 4) Decide whether to fetch any data for this turn
  let analysisCountry: CountryMode = null;
  let usData: USStockData | null = null;
  let inData: IndiaStockFundamentals | null = null;

  const isPureSelection = !!selectedCountry && !previousCountry;

  // If user just chose market (this message), do NOT fetch any stock data.
  if (!isPureSelection) {
    if (countryMode === "US" && looksLikeUsSymbol(latestText)) {
      analysisCountry = "US";
      try {
        usData = await fetchStockAnalysis(latestText);
      } catch (err) {
        console.error("US data fetch error", err);
      }
    } else if (countryMode === "IN" && latestText.length > 1) {
      analysisCountry = "IN";
      try {
        inData = fetchIndianStockFundamentals(latestText);
      } catch (err) {
        console.error("Indian NIFTY fetch error", err);
      }
    }
  }

  // 5) Build system prompt
  let systemPrompt = SYSTEM_PROMPT;

  // User has just chosen a market
  if (isPureSelection && selectedCountry) {
    systemPrompt +=
      "\n\nThe user has just chosen their market: " +
      (selectedCountry === "US" ? "US stocks." : "Indian NIFTY 500 stocks.") +
      "\nAcknowledge their choice briefly and ask them to type the stock symbol (for US) " +
      "or the company name / symbol (for Indian NIFTY 500). Do not analyse any stock yet.";
  }

  // US analysis
  if (analysisCountry === "US") {
    if (usData) {
      systemPrompt +=
        "\n\nThe user is analysing a **US stock**. Here is structured JSON data for this symbol:\n" +
        JSON.stringify(usData);
    } else if (looksLikeUsSymbol(latestText)) {
      systemPrompt +=
        "\n\nThe user asked for a US stock symbol, but live data could not be fetched from the API. " +
        "Politely tell them that live data is not available right now for that symbol and ask them to double-check it.";
    }
  }

  // Indian NIFTY 500 analysis
  if (analysisCountry === "IN") {
    if (inData) {
      systemPrompt +=
        "\n\nThe user is analysing an **Indian stock from the NIFTY 500 list**. " +
        "Here is structured JSON data for this stock:\n" +
        JSON.stringify(inData);
    } else if (latestText.length > 1) {
      systemPrompt +=
        "\n\nThe user asked for an Indian stock that is **not present in the NIFTY 500 CSV**. " +
        "Politely tell them that this stock is not part of the NIFTY 500 list in the current version " +
        "and ask them to enter a stock that is part of NIFTY 500.";
    }
  }

  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools: { webSearch, vectorDatabaseSearch },
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
