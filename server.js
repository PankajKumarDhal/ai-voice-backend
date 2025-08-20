const express = require("express")
const WebSocket = require("ws")
const http = require("http")
const cors = require("cors")
const { GoogleGenerativeAI } = require("@google/generative-ai")
const fs = require('fs')
const path = require('path')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// Middleware
app.use(cors())
app.use(express.json())

const GEMINI_API_KEY = "AIzaSyBRni1VvsE2ml-uUb9ygOW2ufx7nOcFsKA"
// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "your-api-key-here")

// System instructions for Revolt Motors context
const SYSTEM_INSTRUCTIONS = `How can I help you today? `

// Speech-to-Text Service using Gemini
class GeminiSpeechService {
  constructor() {
    this.tempDir = path.join(__dirname, 'temp')
    this.ensureTempDir()
    this.model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    })
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }
  }

  // Convert audio buffer to base64
  audioToBase64(audioData) {
    return Buffer.from(audioData).toString('base64')
  }

  // Determine audio format and mime type
  getAudioMimeType(audioData) {
    // Simple audio format detection based on header bytes
    const header = Array.from(audioData.slice(0, 12))
    
    // WAV file signature
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
      return 'audio/wav'
    }
    
    // WebM/OGG Opus (common in browsers)
    if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
      return 'audio/webm'
    }
    
    // MP3 file signature
    if ((header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) || 
        (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)) {
      return 'audio/mp3'
    }
    
    // Default to wav if unknown
    return 'audio/wav'
  }

  // Use Gemini to process audio and extract speech
  async speechToTextGemini(audioData) {
    try {
      console.log("[Server] Converting speech to text using Gemini...")
      
      if (!audioData || audioData.length === 0) {
        throw new Error("No audio data provided")
      }

      // Convert audio to base64
      const audioBase64 = this.audioToBase64(audioData)
      const mimeType = this.getAudioMimeType(audioData)
      
      console.log(`[Server] Processing ${audioData.length} bytes of ${mimeType} audio`)

      // Create the audio part for Gemini
      const audioPart = {
        inlineData: {
          data: audioBase64,
          mimeType: mimeType
        }
      }

      // Ask Gemini to transcribe the audio
      const prompt = "Please transcribe the speech in this audio file. Return only the transcribed text, nothing else. If you cannot hear any speech or the audio is unclear, return 'UNCLEAR_AUDIO'."
      
      const result = await this.model.generateContent([prompt, audioPart])
      const response = await result.response
      const text = response.text().trim()

      if (text && text !== 'UNCLEAR_AUDIO' && text.length > 0) {
        console.log("[Server] Gemini transcription result:", text)
        return text
      } else {
        console.log("[Server] Gemini could not transcribe audio clearly")
        return null
      }
    } catch (error) {
      console.error("[Server] Gemini speech-to-text error:", error)
      
      // Fallback: Try to use Web Speech API approach if available
      return await this.fallbackTranscription(audioData)
    }
  }

  // Fallback transcription method
  async fallbackTranscription(audioData) {
    try {
      console.log("[Server] Using fallback transcription method...")
      
      // Simple heuristic based on audio characteristics
      const audioLength = audioData.length
      const averageAmplitude = this.calculateAverageAmplitude(audioData)
      
      // If audio seems to contain speech (based on length and amplitude)
      if (audioLength > 8000 && averageAmplitude > 50) {
        // Return a prompt asking user to repeat
        return "I heard some audio but couldn't transcribe it clearly"
      }
      
      return null
    } catch (error) {
      console.error("[Server] Fallback transcription error:", error)
      return null
    }
  }

  // Calculate average amplitude of audio data
  calculateAverageAmplitude(audioData) {
    if (!audioData || audioData.length === 0) return 0
    
    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      sum += Math.abs(audioData[i] - 128) // Assuming 8-bit audio
    }
    return sum / audioData.length
  }

  // Main speech-to-text method
  async speechToText(audioData) {
    try {
      console.log("[Server] Converting speech to text...")
      
      if (!audioData || audioData.length === 0) {
        console.log("[Server] No audio data provided")
        return null
      }

      // Use Gemini for speech-to-text
      return await this.speechToTextGemini(audioData)
    } catch (error) {
      console.error("[Server] Speech-to-text error:", error)
      return null
    }
  }
}

// Initialize Speech-to-Text service
const speechService = new GeminiSpeechService()

class VoiceChatSession {
  constructor(ws) {
    this.ws = ws
    this.model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: SYSTEM_INSTRUCTIONS,
    })
    this.conversationHistory = []
    this.isProcessing = false
  }

  async processAudioInput(audioData) {
    if (this.isProcessing) {
      console.log("[Server] Already processing, skipping...")
      return
    }

    this.isProcessing = true

    try {
      console.log("[Server] Processing audio input...")

      // Convert audio data to text using Gemini
      const transcript = await this.speechToText(audioData)

      if (transcript) {
        // Send transcript to client
        this.ws.send(
          JSON.stringify({
            type: "transcript",
            speaker: "user",
            text: transcript,
          }),
        )

        // Generate AI response
        const response = await this.generateResponse(transcript)

        if (response) {
          // Send transcript of AI response
          this.ws.send(
            JSON.stringify({
              type: "transcript",
              speaker: "ai",
              text: response,
            }),
          )

          // Convert response to speech and send audio
          const audioResponse = await this.textToSpeech(response)

          if (audioResponse) {
            this.ws.send(
              JSON.stringify({
                type: "audio_response",
                audio: Array.from(audioResponse),
              }),
            )
          }
        }
      } else {
        // Send feedback when no transcript is available
        this.ws.send(
          JSON.stringify({
            type: "transcript",
            speaker: "system",
            text: "I couldn't understand the audio clearly.",
          }),
        )
      }
    } catch (error) {
      console.error("[Server] Error processing audio:", error)
      this.ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to process audio input. Please try again.",
        }),
      )
    } finally {
      this.isProcessing = false
    }
  }

  async speechToText(audioData) {
    try {
      // Use Gemini-based speech-to-text service
      return await speechService.speechToText(audioData)
    } catch (error) {
      console.error("[Server] Speech-to-text error:", error)
      return null
    }
  }

  async generateResponse(userInput) {
    try {
      console.log("[Server] Generating AI response for:", userInput)

      // Add user input to conversation history
      this.conversationHistory.push({
        role: "user",
        parts: [{ text: userInput }],
      })

      // Generate response using Gemini
      const chat = this.model.startChat({
        history: this.conversationHistory.slice(-10), // Keep last 10 messages for context
      })

      const result = await chat.sendMessage(userInput)
      const response = result.response.text()

      // Add AI response to conversation history
      this.conversationHistory.push({
        role: "model",
        parts: [{ text: response }],
      })

      console.log("[Server] Generated response:", response.substring(0, 100) + "...")
      return response
    } catch (error) {
      console.error("[Server] Error generating response:", error)
      return "I'm sorry, I'm having trouble processing your request right now."
    }
  }

  async textToSpeech(text) {
    // Simple TTS simulation - in production you could use Gemini for TTS as well
    try {
      console.log("[Server] Converting text to speech...")

      // Simulate processing delay
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Generate dummy audio data (in production, this could use Gemini's audio generation)
      const dummyAudioLength = Math.max(1000, text.length * 50)
      const audioBuffer = new Uint8Array(dummyAudioLength)

      // Fill with dummy audio data (sine wave simulation)
      for (let i = 0; i < audioBuffer.length; i++) {
        audioBuffer[i] = Math.sin(i * 0.01) * 127 + 128
      }

      return audioBuffer
    } catch (error) {
      console.error("[Server] Text-to-speech error:", error)
      return null
    }
  }
}

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("[Server] New WebSocket connection established")

  const session = new VoiceChatSession(ws)

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message)
      console.log("[Server] Received message type:", data.type)

      if (data.type === "audio_input") {
        await session.processAudioInput(new Uint8Array(data.audio))
      } else if (data.type === "text_input") {
        // Handle direct text input for testing
        const response = await session.generateResponse(data.text)
        if (response) {
          ws.send(
            JSON.stringify({
              type: "transcript",
              speaker: "ai",
              text: response,
            }),
          )
        }
      }
    } catch (error) {
      console.error("[Server] Error handling message:", error)
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Invalid message format",
        }),
      )
    }
  })

  ws.on("close", () => {
    console.log("[Server] WebSocket connection closed")
  })

  ws.on("error", (error) => {
    console.error("[Server] WebSocket error:", error)
  })
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!GEMINI_API_KEY
    }
  })
})

// Test endpoint for speech-to-text
app.post("/test-speech", express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
  try {
    const audioData = new Uint8Array(req.body)
    const transcript = await speechService.speechToText(audioData)
    
    res.json({
      success: !!transcript,
      transcript: transcript,
      audioSize: audioData.length,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error("Test speech error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// Test endpoint for text chat
app.post("/test-text", express.json(), async (req, res) => {
  try {
    const { text } = req.body
    if (!text) {
      return res.status(400).json({ error: "Text is required" })
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: SYSTEM_INSTRUCTIONS,
    })

    const result = await model.generateContent(text)
    const response = result.response.text()
    
    res.json({
      success: true,
      input: text,
      response: response,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error("Test text error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// Start server
const PORT = process.env.PORT || 3010
server.listen(PORT, () => {
  console.log(`[Server] Voice Chat AI server running on port ${PORT}`)
  console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}`)
  console.log(`[Server] Health check: http://localhost:${PORT}/health`)
  console.log(`[Server] Test speech endpoint: POST http://localhost:${PORT}/test-speech`)
  console.log(`[Server] Test text endpoint: POST http://localhost:${PORT}/test-text`)
  
  // Log service status
  console.log(`[Server] Gemini API: ${GEMINI_API_KEY ? '✓ Available' : '✗ Not configured'}`)
  
  if (!GEMINI_API_KEY) {
    console.warn(`[Server] WARNING: GEMINI_API_KEY not set. Please set it in your environment variables.`)
  }
})

// Clean up temp directory on exit
process.on('exit', () => {
  const tempDir = path.join(__dirname, 'temp')
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

module.exports = { app, server }