const express = require("express");
const cors = require("cors");
const Retell = require("retell-sdk");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-config.json");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const webhookRoutes = require("./src/routes/webhookRoutes");
const axios = require("axios"); // Missing axios import

const app = express();

// Initialize Firebase Admin with service account
admin.initializeApp(
  {
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "wannes-whitelabelled.appspot.com",
  },
  "appTwo",
);

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Initialize Retell client
const client = new Retell({
  apiKey: "key_b519607900dcb828b833ac62086a",
});

// Middleware

// Enable CORS for all routes
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));

app.use(express.json());

// Handle preflight requests
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// Welcome messages
app.get('/api/welcome-messages', async (req, res) => {
  try {
    const agents = await client.agent.list();
    const welcomeMessages = agents.map(agent => ({
      message: agent.begin_message,
    }));
    res.status(200).json({welcomeMessages: welcomeMessages && welcomeMessages.length > 0 ? welcomeMessages : []});
  } catch (error) {
    console.error('Error fetching welcome messages:', error);
    res.status(500).json({ error: 'Failed to fetch welcome messages' });
  }
});

// List voices endpoint
app.get("/api/list-voices", async (req, res) => {
  try {
    const voiceResponses = await client.voice.list();

    res.status(200).json({
      success: true,
      voices: voiceResponses,
    });
  } catch (error) {
    console.error("Error listing voices:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list voices",
    });
  }
});

// List agents endpoint
app.get("/api/list-agents", async (req, res) => {
  try {
    const { user_id, workspace_id } = req.query;

    if (!user_id || !workspace_id) {
      return res.status(400).json({
        success: false,
        error: "User ID and workspace ID are required",
      });
    }

    // Get agents from Firestore
    const agentsRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("agents");

    const agentsSnapshot = await agentsRef.get();

    const agents = [];
    agentsSnapshot.forEach((doc) => {
      agents.push({
        agent_id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      agents,
    });
  } catch (error) {
    console.error("Error listing agents:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list agents",
    });
  }
});

// List knowledge bases for user endpoint
app.get("/api/knowledge-bases", async (req, res) => {
  try {
    const { user_id, workspace_id = "1" } = req.query;
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }
    // Query Firestore for user-specific knowledge bases
    const kbSnapshot = await db
      .collection("users")
      .doc(user_id.toString())
      .collection("workspaces")
      .doc(workspace_id.toString())
      .collection("knowledge_bases")
      .orderBy("created_at", "desc")
      .get();

    const knowledge_bases = [];
    kbSnapshot.forEach((doc) => {
      const data = doc.data();
      knowledge_bases.push({
        ...data,
        knowledge_base_id: doc.id, // Adding the document ID as knowledge_base_id
        knowledge_base_name: data.original_name || data.knowledge_base_name,
      });
    });

    const knowledge_bases_data = await Promise.all(
      knowledge_bases.map(async (kb) => {
        try {
          const details = await client.knowledgeBase.retrieve(
            kb.knowledge_base_id,
          );
          return details;
        } catch (err) {
          console.warn(
            `Failed to fetch knowledge base ${kb.knowledge_base_id}:`,
            err.message,
          );
          return null;
        }
      }),
    );
    const filtered_knowledge_bases_data = knowledge_bases_data.filter(Boolean);

    res.json({
      success: true,
      knowledge_bases_data: filtered_knowledge_bases_data,
    });
  } catch (error) {
    console.error("Error fetching knowledge bases:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch knowledge bases",
    });
  }
});

// Create knowledge base endpoint
app.post("/api/create-knowledge-base", async (req, res) => {
  try {
    const {
      user_id,
      workspace_id,
      knowledge_base_name,
      document_urls,
      type,
      text_content,
    } = req.body;

    if (!user_id || !workspace_id || !knowledge_base_name) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    let knowledgeBaseParams = {
      knowledge_base_name,
      enable_auto_refresh: true,
      knowledge_base_urls: undefined,
      knowledge_base_texts: undefined,
      knowledge_base_files: undefined,
    };

    // Create temp directory for file downloads
    const tempDir = path.join(os.tmpdir(), "kb-files");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    // Handle different types of content
    switch (type) {
      case "webpages":
        if (!document_urls?.length) {
          return res.status(400).json({
            success: false,
            error: "No URLs provided for webpage type",
          });
        }
        knowledgeBaseParams.knowledge_base_urls = document_urls;
        break;

      case "files":
        if (!document_urls?.length) {
          return res.status(400).json({
            success: false,
            error: "No file URLs provided",
          });
        }
        try {
          const fileStreams = await Promise.all(
            document_urls.map(async (url) => {
              const tempFilePath = path.join(tempDir, `file-${Date.now()}`);

              await new Promise((resolve, reject) => {
                https
                  .get(url, (response) => {
                    const fileStream = fs.createWriteStream(tempFilePath);
                    response.pipe(fileStream);
                    fileStream.on("finish", () => {
                      fileStream.close();
                      resolve();
                    });
                  })
                  .on("error", reject);
              });
              return fs.createReadStream(tempFilePath);
            }),
          );
          knowledgeBaseParams.knowledge_base_files = fileStreams;
        } catch (error) {
          console.error("Error processing files:", error);
          throw new Error("Failed to process files");
        }
        break;

      case "text":
        if (!text_content) {
          return res.status(400).json({
            success: false,
            error: "No text content provided",
          });
        }
        knowledgeBaseParams.knowledge_base_texts = [
          {
            text: text_content,
            title: `Manual Entry ${new Date().toISOString()}`,
          },
        ];
        break;

      default:
        return res.status(400).json({
          success: false,
          error: "Invalid content type",
        });
    }

    // Create knowledge base in Retell
    const knowledgeBase =
      await client.knowledgeBase.create(knowledgeBaseParams);

    // Clean up temp files
    if (type === "files") {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Save to Firestore
    const kbRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("knowledge_bases")
      .doc(knowledgeBase.knowledge_base_id);

    await kbRef.set({
      ...knowledgeBase,
      type,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      created_by: user_id,
    });

    res.json({
      success: true,
      knowledge_base: knowledgeBase,
    });
  } catch (error) {
    console.error("Error creating knowledge base:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to create knowledge base",
    });
  }
});

// Delete knowledge base endpoint
app.delete("/api/delete-knowledge-base/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, workspace_id } = req.query;

    if (!id || !user_id || !workspace_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: id, user_id, or workspace_id",
      });
    }
    await client.knowledgeBase.delete(id);
    const kbRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("knowledge_bases")
      .doc(id);
    await kbRef.delete();
    res.json({
      success: true,
      message: "Knowledge base deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting knowledge base:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete knowledge base",
    });
  }
});

// Create agent endpoint
app.post("/api/create-agent", async (req, res) => {
  try {
    const { user_id, workspace_id, llm_data, agent_data } = req.body;

    if (!user_id || !workspace_id || !llm_data || !agent_data) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Create LLM
    const llmResponse = await client.llm.create();
    const llm_id = llmResponse.llm_id;

    // Create Agent with LLM
    const agentResponse = await client.agent.create({
      response_engine: { llm_id, type: "retell-llm" },
      voice_id: "11labs-Adrian", // Using the specified voice
    });
    const agent_id = agentResponse.agent_id;

    // Save to Firestore
    const agentRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("agents")
      .doc(agent_id);

    await agentRef.set({
      llm_id,
      agent_id,
      ...agent_data,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      agent_id,
      llm_id,
    });
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create agent",
    });
  }
});

// Get agent endpoint
app.get("/api/get-agent", async (req, res) => {
  try {
    const { agent_id } = req.query;

    if (!agent_id) {
      return res.status(400).json({
        success: false,
        error: "Agent ID is required",
      });
    }

    // Get agent details from Retell
    const agentResponse = await client.agent.retrieve(agent_id);
    const llm_id = agentResponse.response_engine.llm_id;

    // Get LLM details from Retell
    const llmResponse = await client.llm.retrieve(llm_id);

    // Combine the data
    const agentData = {
      ...agentResponse,
      llm_data: llmResponse,
    };

    res.json({
      success: true,
      agent: agentData,
    });
  } catch (error) {
    console.error("Error retrieving agent:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve agent",
    });
  }
});

// Start web call endpoint
app.post("/api/start-web-call", async (req, res) => {
  try {
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({
        success: false,
        error: "Agent ID is required",
      });
    }

    // Create web call using Retell client
    const webCallResponse = await client.call.createWebCall({ agent_id });

    res.json({
      success: true,
      accessToken: webCallResponse.access_token,
    });
  } catch (error) {
    console.error("Error starting web call:", error);
    res.status(500).json({
      success: false,
      error: "Failed to start web call",
    });
  }
});

// Update LLM endpoint
app.post("/api/update-llm", async (req, res) => {
  try {
    const { user_id, workspace_id, llm_data } = req.body;

    console.log(llm_data);

    if (!user_id || !workspace_id || !llm_data || !llm_data.llm_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Update LLM in Retell
    const response = await client.llm.update(llm_data.llm_id, {
      general_prompt: llm_data.general_prompt,
      general_tools: llm_data.general_tools,
      begin_message: llm_data.begin_message, // Added begin_message here
      knowledge_base_ids: llm_data.knowledge_base_ids,
    });

    console.log(response);

    // Update in Firestore
    const llmRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("llms")
      .doc(llm_data.llm_id);

    await llmRef.set(
      {
        ...llm_data,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({
      success: true,
      message: "LLM updated successfully",
    });
  } catch (error) {
    console.error("Error updating LLM:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update LLM",
    });
  }
});

// Update agent endpoint
app.post("/api/update-agent", async (req, res) => {
  try {
    const { user_id, workspace_id, agent_data } = req.body;

    if (!user_id || !workspace_id || !agent_data || !agent_data.agent_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Update agent in Retell
    const updateData = {
      voice_id: agent_data.voice_id,
      agent_name: agent_data.agent_name,
      language: agent_data.language,
      webhook_url: agent_data.webhook_url,
      voice_speed: agent_data.voice_speed,
      // Removed begin_message from here since it's now handled in LLM update
      enable_voicemail_detection: agent_data.enable_voicemail_detection,
      end_call_after_silence_ms: agent_data.end_call_after_silence_ms,
      max_call_duration_ms: agent_data.max_call_duration_ms,
      begin_message_delay_ms: agent_data.begin_message_delay_ms,
      ambient_sound: agent_data.ambient_sound,
      responsiveness: agent_data.responsiveness,
      interruption_sensitivity: agent_data.interruption_sensitivity,
      enable_backchannel: agent_data.enable_backchannel,
      backchannel_words: agent_data.backchannel_words,
      pronunciation_dictionary: agent_data.pronunciation_dictionary,
    };

    // Remove undefined values
    Object.keys(updateData).forEach(
      (key) => updateData[key] === undefined && delete updateData[key],
    );

    await client.agent.update(agent_data.agent_id, updateData);

    // Update in Firestore
    const agentRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("agents")
      .doc(agent_data.agent_id);

    await agentRef.set(
      {
        ...agent_data,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({
      success: true,
      message: "Agent updated successfully",
    });
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update agent",
    });
  }
});

// List phone numbers for user endpoint 
app.get("/api/phone-numbers", async (req, res) => {
  try {
    const { user_id, workspace_id = "1" } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    // Query Firestore for user-specific phone numbers
    const phoneNumbersRef = db
      .collection("users")
      .doc(user_id.toString())
      .collection("workspaces")
      .doc(workspace_id.toString())
      .collection("phone_numbers");

    const phoneNumbersSnapshot = await phoneNumbersRef.orderBy("created_at", "desc").get();

    const phone_numbers = [];
    phoneNumbersSnapshot.forEach((doc) => {
      phone_numbers.push({
        phone_number_id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      phone_numbers,
    });
  } catch (error) {
    console.error("Error listing phone numbers:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list phone numbers",
    });
  }
});

// Create phone number endpoint
// app.post("/api/create-phone-number", async (req, res) => {
//   try {
//     const {
//       phone_number,
//       area_code,
//       nickname,
//       inbound_agent_id,
//       outbound_agent_id,
//     } = req.body;

//     if (!phone_number || !area_code) {
//       return res.status(400).json({
//         success: false,
//         error: "Phone number and area code are required",
//       });
//     }

//     const phoneNumberResponse = await client.phoneNumber.create({
//       phone_number,
//       area_code,
//       nickname,
//       inbound_agent_id,
//       outbound_agent_id,
//     });

//     res.json({
//       success: true,
//       phone_number: phoneNumberResponse,
//     });
//   } catch (error) {
//     console.error("Error creating phone number:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to create phone number",
//     });
//   }
// });

// Update phone number endpoint
app.post("/api/update-phone-number", async (req, res) => {
  try {
    const {
      user_id,
      workspace_id,
      phone_number,
      nickname,
      inbound_agent_id,
      outbound_agent_id,
    } = req.body;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required",
      });
    }

    const updateData = {
      nickname,
      inbound_agent_id,
      outbound_agent_id,
    };

    // Remove undefined values
    Object.keys(updateData).forEach(
      (key) => updateData[key] === undefined && delete updateData[key],
    );

    const phoneNumberResponse = await client.phoneNumber.update(
      phone_number,
      updateData,
    );

    const phoneNumberRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("phone_numbers")
      .doc(phoneNumberResponse.phone_number);

    await phoneNumberRef.set({
      ...phoneNumberResponse,
    });

    res.json({
      success: true,
      message: "Phone number updated successfully",
    });
  } catch (error) {
    console.error("Error updating phone number:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update phone number",
    });
  }
});

// Delete phone number endpoint
app.delete("/api/delete-phone-number/:phone_number", async (req, res) => {
  try {
    const { phone_number } = req.params;

    await client.phoneNumber.delete(phone_number);

    res.json({
      success: true,
      message: "Phone number deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting phone number:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete phone number",
    });
  }
});


// app.get("/api/list", async (req, res) => {
//   try {
//     const callResponses = await client.call.list();

// console.log(callResponses);
//     res.json(callResponses);
//   } catch (error) {
//     console.error("Error listing phone numbers:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to list phone numbers",
//     });
//   }
// });


app.post("/api/list", async (req, res) => {
  try {
    const { agent_ids } = req.body;

    if (!Array.isArray(agent_ids) || agent_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: "agent_ids must be a non-empty array",
      });
    }

    const callResponses = await client.call.list({
      filter_criteria: {
        agent_id: agent_ids,
      },
    });

    // console.log("Call responses:", callResponses);
    res.json(callResponses);
  } catch (error) {
    console.error("Error fetching call list:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch call list",
    });
  }
});



// Make outbound call endpoint
app.post("/api/make-outbound-call", async (req, res) => {
  try {
    const { from_phone_number, to_phone_number } = req.body;

    if (!from_phone_number || !to_phone_number) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required",
      });
    }

    const callResponse = await client.call.createPhoneCall({
      from_number: from_phone_number,
      to_number: to_phone_number,
    });

    res.json({
      success: true,
      call: callResponse,
    });
  } catch (error) {
    console.error("Error making outbound call:", error);
    res.status(500).json({
      success: false,
      error: "Failed to make outbound call",
    });
  }
});

app.post("/api/create-phone-number", async (req, res) => {
  try {
    const { user_id, workspace_id, area_code } = req.body;

    if (!user_id || !workspace_id || !area_code) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Create phone number in Retell
    const phoneNumberResponse = await client.phoneNumber.create({
      area_code,
    });

    console.log(phoneNumberResponse);

    // Save to Firestore
    const phoneNumberRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("phone_numbers")
      .doc(phoneNumberResponse.phone_number);

    await phoneNumberRef.set({
      ...phoneNumberResponse,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      phone_number: phoneNumberResponse,
    });
  } catch (error) {
    console.error("Error creating phone number:", error);
    res.status(500).json({
      success: false,
      error: `Failed to create phone number: ${error?.message}`,
    });
  }
});

// Import phone number endpoint
app.post("/api/import-sip-phone-number", async (req, res) => {
  try {
    const {
      user_id,
      workspace_id,
      phone_number,
      termination_uri,
      sip_trunk_auth_username,
      sip_trunk_auth_password,
      inbound_agent_id,
      outbound_agent_id,
      inbound_agent_version,
      outbound_agent_version,
      nickname,
      inbound_webhook_url,
    } = req.body;

    // Validate required fields
    if (!user_id || !workspace_id || !phone_number || !termination_uri) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: user_id, workspace_id, phone_number, termination_uri",
      });
    }

    // Prepare the import data for Retell API
    const importData = {
      phone_number,
      termination_uri,
      sip_trunk_auth_username,
      sip_trunk_auth_password,
      inbound_agent_id,
      outbound_agent_id,
      inbound_agent_version,
      outbound_agent_version,
      nickname,
      inbound_webhook_url,
    };

    // Remove undefined values
    Object.keys(importData).forEach(
      (key) => importData[key] === undefined && delete importData[key],
    );

    // Make request to Retell API
    const response = await axios.post(
      "https://api.retellai.com/import-phone-number",
      importData,
      {
        headers: {
          "Authorization": `Bearer key_b519607900dcb828b833ac62086a`,
          "Content-Type": "application/json",
        },
      }
    );

    const phoneNumberResponse = response.data;

    // Save to Firestore
    const phoneNumberRef = db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .collection("phone_numbers")
      .doc(phoneNumberResponse.phone_number);

    await phoneNumberRef.set({
      ...phoneNumberResponse,
      imported: true,
      phone_number_type: phoneNumberResponse.phone_number_type || "sip",
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      phone_number: phoneNumberResponse,
      message: "Phone number imported successfully",
    });
  } catch (error) {
    console.error("Error importing phone number:", error);

    // Handle different types of errors
    if (error.response) {
      // API error response
      return res.status(error.response.status).json({
        success: false,
        error: "Failed to import phone number",
        details: error.response.data,
      });
    } else if (error.request) {
      // Network error
      return res.status(503).json({
        success: false,
        error: "Failed to connect to Retell API",
        details: "Network error occurred",
      });
    } else {
      // Other errors
      return res.status(500).json({
        success: false,
        error: `Failed to import phone number: ${error.message}`,
      });
    }
  }
});

app.post("/api/webhook", async (req, res) => {
  console.log("Webhook triggered");
  console.log(req.body);

  // Step 1: Check if the event is 'call_analyzed'
  if (req.body.event !== "call_analyzed") {
    console.log(`Event '${req.body.event}' is not 'call_analyzed'. Ignoring.`);
    return res.sendStatus(200);
  }

  const call = req.body.call;
  const agentId = call.agent_id;
  const callId = call.call_id;
  const callTimestamp = call.start_timestamp; // Ensure this is in a valid timestamp format
  const callCost = call.call_cost?.combined_cost || 0;

  if (!agentId || !callId || !callTimestamp) {
    console.error(
      "Missing agent_id, call_id, or start_timestamp in the request body.",
    );
    return res
      .status(400)
      .send("Bad Request: Missing agent_id, call_id, or start_timestamp.");
  }

  try {
    // Step 2: Use a Collection Group Query to find the agent document
    console.log(agentId);
    const agentQuerySnapshot = await db
      .collectionGroup("agents")
      .where("agent_id", "==", agentId)
      .orderBy("created_at", "desc")
      .limit(1) // Assuming agent_id is unique
      .get();

    if (agentQuerySnapshot.empty) {
      console.warn(`Agent ID '${agentId}' not found in Firestore.`);
      return res.sendStatus(200); // Optionally, you might want to respond differently
    }

    // Assuming agent_id is unique and only one document is found
    const agentDoc = agentQuerySnapshot.docs[0];
    const agentRef = agentDoc.ref;

    // Navigate up the document hierarchy to get workspace and user
    const workspaceRef = agentRef.parent.parent;
    if (!workspaceRef) {
      console.error("Workspace reference not found for the agent.");
      return res
        .status(500)
        .send("Internal Server Error: Workspace not found.");
    }

    const userRef = workspaceRef.parent.parent;
    if (!userRef) {
      console.error("User reference not found for the workspace.");
      return res.status(500).send("Internal Server Error: User not found.");
    }

    const userId = userRef.id;
    const workspaceId = workspaceRef.id;

    console.log(
      `Agent ID '${agentId}' belongs to User ID '${userId}' and Workspace ID '${workspaceId}'.`,
    );

    // Step 3: Create a new document in 'call_history' sub-collection
    console.log(userId);
    console.log(workspaceId);
    console.log(callId);
    const callHistoryRef = db
      .collection("users")
      .doc(userId)
      .collection("workspaces")
      .doc(workspaceId)
      .collection("call_history")
      .doc(callId);

    // Set the entire call data. Adjust as needed (e.g., exclude sensitive info)

    console.log(call);
    await callHistoryRef.set(call);

    console.log(`Call ID '${callId}' has been saved to 'call_history'.`);

    const invoiceRef = db
      .collection("users")
      .doc(userId)
      .collection("workspaces")
      .doc(workspaceId)
      .collection("invoices")
      .doc(monthKey);

    await invoiceRef.set(
      {
        call_ids: admin.firestore.FieldValue.arrayUnion(callId),
        total_calls: admin.firestore.FieldValue.increment(1),
        total_cost: admin.firestore.FieldValue.increment(callCost),
        invoice_status: "pending", // Default to pending until processed
        generated_at: admin.firestore.Timestamp.fromDate(new Date()),
      },
      { merge: true },
    );

    console.log(
      `Call ID '${callId}' has been added to the invoice for '${monthKey}'. Total cost updated.`
    );

    // Respond with 200 OK
    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Add the webhook routes
app.use("/webhook", webhookRoutes);

const stripe = require("stripe")("sk_test_51QZ3oSA0QAmAFN42cQkYC5xBckGmNPf8lKtjc2llhZp0wBdGVxPe2ILPa0WlaI3CfUC1A2k7DQSSnnJynwuvzPr200AC9siucN");

app.post("/api/create-customer", async (req, res) => {
  const { email } = req.body;
  try {
    if(!email){
      return res.status(400).json({
        error: "Email is required",
        details: "Email is required to create a customer",
      });
    }
    const newCustomer = await stripe.customers.create({
      email: email,
    });
    res.status(200).json({
      customerId: newCustomer.id,
    });
  } catch (error) {
    console.error("Error getting/creating customer ID:", error);
    res.status(500).json({
      error: "Failed to get/create customer ID",
      details: error.message,
    });
  }
});

app.post("/api/create-plan-subscription-session", async (req, res) => {
  const { productId, userId, email, customerId, return_url } = req.body;
  try {
    const product = await stripe.products.retrieve(productId);

    const prices = await stripe.prices.list({
      product: productId,
      active: true,
      limit: 1,
    });

    if (prices.data.length === 0) {
      return res
        .status(400)
        .json({ error: "No active price found for this product" });
    }

    const price = prices.data[0];

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      customer: customerId,
      success_url: `${return_url}?setup_success=true`,
      cancel_url: `${return_url}?setup_canceled=true`,
      metadata: {
        userId: userId,
        email: email,
        productId: productId,
        productName: product.name,
      },
    });

    res.json({
      sessionUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error("Checkout session creation error:", error);
    res.status(500).json({
      error: "Failed to create checkout session",
      details: error.message,
    });
  }
});

app.get("/api/check-active-subscription", async (req, res) => {
  const { customerId } = req.query;
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 10,
    });

    if (subscriptions.data.length === 0) {
      return res.json({
        hasSubscription: false,
        message: "No active subscription found",
      });
    }

    const activeSubscription = subscriptions.data[0];

    if (!activeSubscription) {
      return res.json({
        hasSubscription: true,
        message: "No active subscription found",
      });
    }

    const priceDetails = await stripe.prices.retrieve(
      activeSubscription.items.data[0].price.id,
    );

    const productDetails = await stripe.products.retrieve(priceDetails.product);

    return res.json({
      hasSubscription: true,
      subscriptionDetails: {
        isActive: true,
        subscriptionId: activeSubscription.id,
        planName: productDetails.name,
        currentPeriodStart: activeSubscription.current_period_start,
        currentPeriodEnd: activeSubscription.current_period_end,
        amount: priceDetails.unit_amount / 100,
        interval: priceDetails.recurring.interval,
        productMetadata: productDetails.metadata,
      },
    });
  } catch (error) {
    console.error("Subscription check error:", error);
    return res.status(500).json({
      error: "Failed to check subscription",
      details: error.message,
    });
  }
});

app.post("/api/setup-subscription-payment-method", async (req, res) => {
  const { userId, email, customerId, return_url } = req.body;
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: `${return_url}?setup_success=true&customer_id=${customerId}`,
      cancel_url: `${return_url}?setup_canceled=true`,

      metadata: {
        userId: userId,
        email: email,
        intent: "payment_method_setup",
      },
    });

    res.json({
      success: true,
      sessionUrl: session.url,
      sessionId: session.id,
      setupIntentClientSecret: setupIntent.client_secret,
    });
  } catch (error) {
    console.error("Payment method setup error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/check-payment-method-setup", async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) {
    return res.status(400).json({
      success: false,
      error: "Customer ID is required",
    });
  }
  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 10, // Limiting to recent sessions
    });

    // Filter for sessions that were specifically for dynamic payment method setup
    const dynamicPaymentSessions = sessions.data.filter(
      (session) =>
        session.metadata?.intent === "payment_method_setup" &&
        session.status === "complete" &&
        session.mode === "setup",
    );
    // Determine if the user has a valid payment method set up
    const hasValidPaymentMethod = paymentMethods.data.length > 0;
    // Check if any of the setup intents has metadata indicating it was for dynamic payments
    const hasDynamicPaymentSetup = dynamicPaymentSessions.length > 0;

    let defaultPaymentMethod = null;
    // Get the default payment method if available
    if (hasValidPaymentMethod) {
      // Try to get the customer to see if they have a default payment method
      const customer = await stripe.customers.retrieve(customerId);
      defaultPaymentMethod =
        customer.invoice_settings?.default_payment_method || null;
    }

    res.json({
      success: true,
      hasValidPaymentMethod,
      hasDynamicPaymentSetup,
      defaultPaymentMethod,
      paymentMethods: paymentMethods.data.map((pm) => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        isDefault: pm.id === defaultPaymentMethod,
      })),
    });
  } catch (error) {
    console.error("Payment method check error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/invoices/:customer_id", async (req, res) => {
  try {
    const { customer_id } = req.params;

    const invoices = await stripe.invoices.list({
      customer: customer_id,
      limit: 10,
    });

    res.json({
      success: true,
      invoices: invoices.data,
    });
  } catch (error) {
    console.error("Invoice listing error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate invoice with custom amount (call this at month end)
app.post("/api/generate-invoice", async (req, res) => {
  try {
    const { customer_id, amount, description } = req.body;

    if (!customer_id || !amount) {
      return res
        .status(400)
        .json({ error: "Customer ID and amount are required" });
    }

    const customer = await stripe.customers.retrieve(customer_id);
    if (!customer || customer.deleted) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const invoiceItem = await stripe.invoiceItems.create({
      customer: customer_id,
      amount: Math.round(amount * 100),
      currency: "usd",
      description: description || "Monthly service fee",
    });

    const invoice = await stripe.invoices.create({
      customer: customer_id,
      auto_advance: true,
      collection_method: "charge_automatically",
      description: `Invoice for ${new Date().toLocaleDateString()}`,
    });

    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    let paidInvoice = finalizedInvoice;
    if (finalizedInvoice.status !== "paid") {
      try {
        paidInvoice = await stripe.invoices.pay(invoice.id);
      } catch (payError) {
        console.error("Payment error:", payError);
      }
    }

    res.json({
      success: true,
      invoice_id: paidInvoice.id,
      amount: amount,
      status: paidInvoice.status,
      invoice_pdf: paidInvoice.invoice_pdf,
      hosted_invoice_url: paidInvoice.hosted_invoice_url,
    });
  } catch (error) {
    console.error("Invoice generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});