import express from "express";
import { GoogleGenAI } from "@google/genai";
import { SiweMessage, generateNonce } from "siwe";

let ai: GoogleGenAI | null = null;
try {
  if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
} catch (e) {
  console.error("Failed to initialize Gemini AI", e);
}

const activeNonces = new Set<string>();
let activeSiweSession: {
  address: string;
  chainId: number;
  verifiedAt: number;
} | null = null;

export const app = express();
app.use(express.json());

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// SIWE - Generate Nonce
app.get("/api/siwe/nonce", (_req, res) => {
  const nonce = generateNonce();
  activeNonces.add(nonce);
  res.json({ nonce });
});

// SIWE - Verify Signature
app.post("/api/siwe/verify", async (req, res) => {
  try {
    const { message, signature } = req.body;
    if (!message || !signature) {
      return res.status(400).json({ error: "Missing message or signature in request body" });
    }

    const siweMessage = new SiweMessage(message);
    
    const result = await siweMessage.verify({
      signature,
    });

    if (!result.success) {
      return res.status(401).json({ error: "SIWE signature verification failed", success: false });
    }

    activeSiweSession = {
      address: result.data.address,
      chainId: result.data.chainId,
      verifiedAt: Date.now(),
    };

    res.json({
      success: true,
      address: result.data.address,
      chainId: result.data.chainId,
      verifiedAt: activeSiweSession.verifiedAt,
    });
  } catch (error: any) {
    console.error("SIWE Verification Error:", error);
    res.status(400).json({
      success: false,
      error: error.message || "Failed to verify SIWE signature",
    });
  }
});

// SIWE - Current Session Status
app.get("/api/siwe/me", (_req, res) => {
  if (activeSiweSession) {
    res.json({
      authenticated: true,
      session: activeSiweSession,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// SIWE - Logout
app.post("/api/siwe/logout", (_req, res) => {
  activeSiweSession = null;
  res.json({ success: true });
});

// API route for AI assistant
app.post("/api/ask", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: "Gemini API key not configured on server." });
    }
    
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: query,
      config: {
        thinkingConfig: {
          thinkingBudget: 1024,
        },
        systemInstruction: 'You are a DeFi trading assistant on UniswapX. Help users with complex crypto trading strategies, token analysis, and DEX mechanics. Be concise and professional.',
      }
    });
    
    res.json({ text: response.text });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: error.message || "Failed to process request" });
  }
});

export default app;
