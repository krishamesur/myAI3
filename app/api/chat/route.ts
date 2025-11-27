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
import { fetchStockAnalysis, fetchIndianStockFundamentals } from "@/lib/stocks";

export const maxDuration = 30;

type CountryMode = "US" | "IN" | null;

// Extract plain text from a UIMessage
function getTextFromMessage(msg: UIMessage): string {
  return msg.parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
    .trim();
}

// Look through conversation history to see last chosen country
function detectCountryFromHistory(messages: UIMessage[]): CountryMode {
  let mode: CountryMode = null;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = getTextFromMessage(msg).toLowerCase();

    if (
      text.includes("us stocks") ||
      text === "us" ||
      text === "usa" ||
      text.includes("united states")
    ) {
      mode = "US";
    } else if (
      text.includes("indian stocks") ||
      text.includes("india") ||
      text.includes("nifty 500") ||
      text === "india"
    ) {
      mode = "IN";
    }
  }

  return mode;
}

// Simple heuristic to see if a string looks like a US style stock symbol
function looksLikeSymbol(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();

  if (trimmed.length < 2 || trimmed.length > 15) return false;
  if (/\s/.test(trimmed)) return false;

  // allow letters, digits, and dot
  if (!/^[A-Za-z0-9.]+$/.test(trimmed)) return false;

  return true;
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // 1) Find latest user message text
  const latestUserMessage = messages.filter((msg) => msg.role === "user").pop();

  let textParts = "";
  if (latestUserMessage) {
    textParts = getTextFromMessage(latestUserMessage);
  }

  // 2) Moderation check: if text breaks rules, stop and reply with denial
  if (textParts) {
    const moderationResult = await isContentFlagged(textParts);

    if (moderationResult.flagged) {
      const stream = createUIMessageStream({
        execute({ writer }) {
          const textId = "moderation-denial-text";

          writer.write({
            type: "start",
          });

          writer.write({
            type: "text-start",
            id: textId,
          });

          writer.write({
            type: "text-delta",
            id: textId,
            delta:
              moderationResult.denialMessage ||
              "Your message violates our guidelines. I can't answer that.",
          });

          writer.write({
            type: "text-end",
            id: textId,
          });

          writer.write({
            type: "finish",
          });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }
  }

  const latestText = textParts.trim();
  const countryMode = detectCountryFromHistory(messages);
  const lower = latestText.toLowerCase();

  let usStockData: any = null;
  let indiaStockData: any = null;
  let analysisCountry: CountryMode = null;
  let shouldAskCountryClarification = false;

  // If no country is chosen yet, we may need to explicitly ask at the start
  let forceAskMarketQuestion = false;

  if (!countryMode) {
    const isGreetingOrGeneric =
      !lower ||
      lower === "hi" ||
      lower === "hello" ||
      lower === "hey" ||
      lower.includes("help") ||
      lower.includes("analyse") ||
      lower.includes("analyze") ||
      lower.includes("research") ||
      lower.includes("stock");

    // For the very first interaction, just ask them which market they want
    if (isGreetingOrGeneric) {
      forceAskMarketQuestion = true;
    }
  }

  // 3) Check if the latest message is just a country selection
  const isUsSelection =
    lower === "us" ||
    lower === "usa" ||
    lower === "us stocks" ||
    lower.includes("united states stocks");

  const isIndiaSelection =
    lower === "india" ||
    lower === "indian stocks" ||
    lower === "nifty 500" ||
    lower.includes("nifty 500 stocks");

  const isCountrySelection = isUsSelection || isIndiaSelection;

  if (isCountrySelection) {
    // User just chose a country. Do not call any stock API now.
    // The model will simply acknowledge and ask for a stock symbol or name.
  } else {
    // 4) Handle stock queries

    // Case A: US mode → only act if it looks like a symbol
    if (countryMode === "US" && looksLikeSymbol(latestText)) {
      analysisCountry = "US";
      try {
        usStockData = await fetchStockAnalysis(latestText);
        console.log("US stock analysis data:", usStockData);
      } catch (error) {
        console.error("Error fetching US stock analysis", error);
      }
    }

    // Case B: India mode → accept symbol-like OR plain company names (eg "HDFC Bank")
    else if (countryMode === "IN" && latestText.length > 1) {
      analysisCountry = "IN";
      try {
        indiaStockData = fetchIndianStockFundamentals(latestText);
        console.log("India stock fundamentals:", indiaStockData);
      } catch (error) {
        console.error("Error fetching Indian stock fundamentals", error);
      }
    }

    // Case C: no country chosen yet, but user typed something that looks like a symbol
    else if (!countryMode && looksLikeSymbol(latestText)) {
      shouldAskCountryClarification = true;
    }
  }

  // 5) Build the system prompt with any data we fetched
  let systemPrompt = SYSTEM_PROMPT;

  if (analysisCountry === "US" && usStockData) {
    systemPrompt +=
      "\n\nThe user is analysing a US stock.\n" +
      "Here is structured US stock data for this symbol, in JSON format. " +
      "Use this data to explain the technical metrics in simple language:\n" +
      JSON.stringify(usStockData);
  }

  if (analysisCountry === "IN") {
    if (indiaStockData) {
      systemPrompt +=
        "\n\nThe user is analysing an Indian stock from the NIFTY 500 list.\n" +
        "Here is structured fundamental data for this stock, in JSON format. " +
        "Use this data to explain the basic fundamental metrics in simple language:\n" +
        JSON.stringify(indiaStockData);
    } else if (latestText.length > 1 && countryMode === "IN") {
      systemPrompt +=
        "\n\nThe user requested analysis for an Indian stock that is not found in the NIFTY 500 CSV.\n" +
        "Politely tell the user that this stock is not part of the NIFTY 500 list right now and ask them to enter a stock from NIFTY 500. " +
        "Do not attempt to analyse the stock.";
    }
  }

  if (shouldAskCountryClarification) {
    systemPrompt +=
      "\n\nThe user has typed what looks like a stock symbol, but they have not chosen between US stocks and Indian NIFTY 500 stocks yet.\n" +
      "Politely ask them which country this stock belongs to (US stocks or Indian NIFTY 500) and do not attempt any analysis until they choose.";
  }

  if (isCountrySelection) {
    systemPrompt +=
      "\n\nThe user has just chosen which market they want to research (US or Indian stocks).\n" +
      "Acknowledge their choice in one short sentence and ask them to type a stock symbol (for US) or a stock symbol or company name (for Indian NIFTY 500) that they want to analyse.";
  }

  if (forceAskMarketQuestion) {
    systemPrompt +=
      "\n\nThe user has not chosen a market yet. Do not analyse any stocks now and do not call any tools.\n" +
      "Ask them this exact question in simple words:\n" +
      "\"Do you want to research US stocks or Indian (NIFTY 500) stocks today?\"\n" +
      "Wait for their answer before you try to analyse any stock.";
  }

  // 6) Call the model as before
  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools: {
      webSearch,
      vectorDatabaseSearch,
    },
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: {
        reasoningSummary: "auto",
        reasoningEffort: "low",
        parallelToolCalls: false,
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
