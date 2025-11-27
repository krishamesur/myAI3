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

// Simple heuristic to see if a string looks like a stock symbol
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

  let usStockData: any = null;
  let indiaStockData: any = null;
  let analysisCountry: CountryMode = null;
  let shouldAskCountryClarification = false;

  // 3) Check if the latest message is just a country selection
  const lower = latestText.toLowerCase();
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
    // The model will simply acknowledge and ask for a stock symbol.
  } else if (looksLikeSymbol(latestText)) {
    // User typed something that looks like a stock symbol

    if (!countryMode) {
      // We do not know yet if this is US or India. Ask for clarification.
      shouldAskCountryClarification = true;
    } else if (countryMode === "US") {
      analysisCountry = "US";
      try {
        usStockData = await fetchStockAnalysis(latestText);
        console.log("US stock analysis data:", usStockData);
      } catch (error) {
        console.error("Error fetching US stock analysis", error);
      }
    } else if (countryMode === "IN") {
      analysisCountry = "IN";
      try {
        indiaStockData = fetchIndianStockFundamentals(latestText);
        console.log("India stock fundamentals:", indiaStockData);
      } catch (error) {
        console.error("Error fetching Indian stock fundamentals", error);
      }
    }
  }

  // 4) Build the system prompt with any data we fetched
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
    } else if (looksLikeSymbol(latestText)) {
      systemPrompt +=
        "\n\nThe user requested analysis for an Indian stock symbol that is not found in the NIFTY 500 CSV.\n" +
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
      "Acknowledge their choice in one short sentence and ask them to type a stock symbol they want to analyse.";
  }

  // 5) Call the model as before
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
