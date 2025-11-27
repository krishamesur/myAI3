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

function getText(msg: UIMessage): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
}

function detectCountry(messages: UIMessage[]): CountryMode {
  let mode: CountryMode = null;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const t = getText(msg).toLowerCase();

    if (t.includes("us stocks") || t === "us" || t === "usa") mode = "US";
    else if (t.includes("indian stocks") || t.includes("india")) mode = "IN";
  }

  return mode;
}

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
  const latest = latestUserMessage ? getText(latestUserMessage) : "";
  const lower = latest.toLowerCase();

  // Moderation
  if (latest) {
    const mod = await isContentFlagged(latest);
    if (mod.flagged) {
      const stream = createUIMessageStream({
        execute({ writer }) {
          writer.write({ type: "start" });
          writer.write({ type: "text-start", id: "deny" });
          writer.write({
            type: "text-delta",
            id: "deny",
            delta:
              mod.denialMessage ||
              "Your message violates our guidelines. I can't answer that.",
          });
          writer.write({ type: "text-end", id: "deny" });
          writer.write({ type: "finish" });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }
  }

  const countryMode = detectCountry(messages);

  let analysisCountry: CountryMode = null;
  let usData: any = null;
  let inData: any = null;

  let askCountryClarify = false;
  let forceAskFirstQuestion = false;

  // FIRST MESSAGE HANDLER
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

    if (isGreeting) forceAskFirstQuestion = true;
  }

  // COUNTRY SELECTION
  const isUsSelection =
    lower === "us" ||
    lower === "usa" ||
    lower.includes("us stocks");

  const isIndiaSelection =
    lower === "india" ||
    lower.includes("indian stocks");

  const isCountrySelection = isUsSelection || isIndiaSelection;

  // STOCK LOGIC
  if (!isCountrySelection) {
    // If US mode picked
    if (countryMode === "US" && looksLikeSymbol(latest)) {
      analysisCountry = "US";
      usData = await fetchStockAnalysis(latest);
    }

    // If India mode picked
    else if (countryMode === "IN" && latest.length > 1) {
      analysisCountry = "IN";
      inData = fetchIndianStockFundamentals(latest);
    }

    // User typed stock without selecting country
    else if (!countryMode && looksLikeSymbol(latest)) {
      askCountryClarify = true;
    }
  }

  // SYSTEM PROMPT BUILD
  let systemPrompt = SYSTEM_PROMPT;

  if (analysisCountry === "US" && usData) {
    systemPrompt +=
      "\n\nThe user is analysing a US stock. Here is the data:\n" +
      JSON.stringify(usData);
  }

  if (analysisCountry === "IN") {
    if (inData)
      systemPrompt +=
        "\n\nThe user is analysing a NIFTY 500 Indian stock. Here is the data:\n" +
        JSON.stringify(inData);
    else
      systemPrompt +=
        "\n\nThe user asked for an Indian stock NOT in NIFTY 500. Tell them to pick a NIFTY500 stock.";
  }

  if (askCountryClarify) {
    systemPrompt +=
      "\n\nThe user typed a stock, but no country chosen. Ask them Indian or US.";
  }

  if (isCountrySelection) {
    systemPrompt +=
      "\n\nThe user selected a market. Acknowledge and ask for the stock.";
  }

  if (forceAskFirstQuestion) {
    systemPrompt +=
      "\n\nFIRST MESSAGE: Ask ONLY this:\n" +
      "\"Hello, Welcome to Stock Unlock. Do you want to research Indian stocks or US stocks?\"";
  }

  // RUN MODEL
  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools: { webSearch, vectorDatabaseSearch },
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
