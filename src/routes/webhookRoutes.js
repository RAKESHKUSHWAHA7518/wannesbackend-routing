/****************************************************
 * Main Code with Integrated Contact Lookup/Creation
 ****************************************************/
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const axios = require("axios");
const { Client } = require("@googlemaps/google-maps-services-js");
const serviceAccount = require("./../../firebase-config.json");

// -------------------- FIREBASE INIT --------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "wannes-whitelabelled.appspot.com",
  });
}

const db = admin.firestore();

// -------------------- MAPS CLIENT --------------------
const mapsClient = new Client({});

// -------------------- GHL CONFIG --------------------
// Adjust these as needed for your environment
const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_TOKEN = "pit-13b404e5-9807-411f-bb96-380723b24d32";
const CONTACTS_API_VERSION = "2021-07-28"; // For contact operations
const APPOINTMENTS_API_VERSION = "2021-04-15"; // For booking operations
// Example: If you prefer environment variables, set them up like:
// const GHL_TOKEN = process.env.GHL_TOKEN || "my-hard-coded-fallback";

/**
 * Utility function to search contacts by phone number (in GHL).
 * @param {string} phoneNumber - The phone number to search for.
 * @param {string} locationId  - The GHL location ID.
 * @returns {Promise<object>}   - The response data from the search contacts API.
 */
async function searchContacts(phoneNumber, locationId) {
  try {
    const searchContactsUrl = `${GHL_BASE_URL}/contacts/search`;
    const response = await axios.post(
      searchContactsUrl,
      {
        locationId: locationId,
        page: 1,
        pageLimit: 20,
        filters: [
          {
            field: "phone",
            operator: "contains",
            value: phoneNumber,
          },
        ],
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${GHL_TOKEN}`,
          "Content-Type": "application/json",
          Version: CONTACTS_API_VERSION,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(
      "Error in searchContacts:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

/**
 * Utility function to create a new contact in GHL.
 * @param {object} contactData - The data for the new contact.
 * @returns {Promise<object>}   - The response data from the create contact API.
 */
async function createContact(contactData) {
  try {
    const createContactUrl = `${GHL_BASE_URL}/contacts/`;
    const response = await axios.post(createContactUrl, contactData, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${GHL_TOKEN}`,
        "Content-Type": "application/json",
        Version: CONTACTS_API_VERSION,
      },
    });
    return response.data;
  } catch (error) {
    console.error(
      "Error in createContact:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

/**
 * Finds (or creates) a contact in GHL by phone number, and returns the contact ID.
 * @param {string} phoneNumber - The phone number to look up.
 * @param {string} locationId  - GHL location ID.
 * @returns {Promise<string>}   - The contact ID to use for an appointment.
 */
async function findOrCreateContactByPhone(phoneNumber, locationId) {
  // 1) Search by phone number
  const searchData = await searchContacts(phoneNumber, locationId);
  const contacts = searchData.contacts || [];

  // 2) If found, return the first contact ID
  if (contacts.length > 0) {
    return contacts[0].id;
  }

  // 3) Otherwise, create a new contact
  const createData = await createContact({
    phone: phoneNumber,
    locationId: locationId,
  });
  // Return newly created contact ID
  return createData.contact.id;
}

/**
 * Computes driving distance between two zip codes using Google Maps Distance Matrix.
 */
async function getDistance(origin, destination) {
  try {
    const response = await mapsClient.distancematrix({
      params: {
        origins: [origin],
        destinations: [destination],
        mode: "driving",
        key: "AIzaSyBqUWrEo5PU5hfIaWespZ4QubfnFzxr07A",
      },
    });

    if (
      response.data.status === "OK" &&
      response.data.rows[0].elements[0].status === "OK"
    ) {
      // Returns distance in meters
      return response.data.rows[0].elements[0].distance.value;
    }
    return null;
  } catch (error) {
    console.error("Error getting distance:", error);
    return null;
  }
}

/**
 * Fetches free slots from GoHighLevel for a given calendarId and date (YYYY-MM-DD).
 * Returns an array of slot strings like "2025-03-10T14:00:00+05:30".
 */
async function getAvailableSlots(calendarId, dateOnly) {
  try {
    // Convert dateOnly (e.g. "2025-03-10") to 00:00 UTC
    const startDate = new Date(`${dateOnly}T00:00:00.000Z`);
    // End date is 24h after start
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

    const response = await axios.get(
      `${GHL_BASE_URL}/calendars/${calendarId}/free-slots`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${GHL_TOKEN}`,
          Version: APPOINTMENTS_API_VERSION,
        },
        params: {
          startDate: startDate.getTime(), // in milliseconds
          endDate: endDate.getTime(),
        },
      }
    );

    const data = response.data || {};
    // GHL returns date-based keys like "2025-03-10": { slots: [...] }
    const dayData = data[dateOnly] || {};
    return dayData.slots || [];
  } catch (error) {
    console.error("Error checking calendar availability:", error);
    return [];
  }
}

/**
 * Creates an appointment in GHL using a full ISO string (time with offset).
 *
 * @param {string} calendarId - The GHL calendar ID
 * @param {string} locationId - The GHL location ID
 * @param {string} isoTime    - Full ISO datetime (e.g., "2025-03-10T14:00:00+05:30")
 * @param {string} contactId  - The contact ID to associate with the appointment
 */
async function createAppointment(calendarId, locationId, isoTime, contactId) {
  try {
    // Convert string to JS Date (preserves offset)
    const startTime = new Date(isoTime);
    // We'll assume a 30-minute appointment (adjust as needed)
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

    const appointmentData = {
      calendarId,
      locationId,
      contactId,
      startTime: startTime.toISOString(), // in UTC
      endTime: endTime.toISOString(),
    };

    const response = await axios.post(
      `${GHL_BASE_URL}/calendars/events/appointments`,
      appointmentData,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${GHL_TOKEN}`,
          "Content-Type": "application/json",
          Version: APPOINTMENTS_API_VERSION,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error creating appointment:", error.response?.data || error.message);
    return null;
  }
}

/**
 * Helper: checks if 'slots' contains an ISO time matching 'desiredTime' in UTC
 */
function hasMatchingSlot(slots, desiredTime) {
  const desiredUtc = new Date(desiredTime).getTime();
  return slots.some((slotStr) => {
    const slotUtc = new Date(slotStr).getTime();
    return slotUtc === desiredUtc;
  });
}

// -----------------------------------------------------
//                 ROUTING WEBHOOK
// -----------------------------------------------------
router.post("/routing/:user_id/:workspace_id", async (req, res) => {
  try {
    /**
     * We expect in req.body:
     * {
     *   "type": "inbound" or "outbound",
     *   "fromnumber": "1234567890",  // if inbound
     *   "tonumber":   "2345678901",  // if outbound
     *   "args": {
     *     "time": "2025-03-10T14:00:00+04:30", // Full ISO
     *     "zipcode": "10001"
     *   }
     * }
     */

    // 1) Determine the phone number
    let phoneNumber;
    if (req.body.call.direction === "inbound") {
      phoneNumber = req.body.call.from_number;
    } else if (req.body.call.direction === "outbound") {
      phoneNumber = req.body.call.to_number;
    }

    // If we still don't have a phone number, handle error
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error:
          "No valid phone number found. Check 'type' and corresponding number fields.",
      });
    }

    // 2) Extract the desired time and zipcode
    const { time, zipcode } = (req.body.args || {});
    if (!time || !zipcode) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields in 'args': time or zipcode.",
      });
    }

    // 3) Extract route params
    const { user_id, workspace_id } = req.params;

    // local date "YYYY-MM-DD" from user’s requested time
    const dateOnly = time.slice(0, 10);

    // 30 min before
    const userTimeMs = new Date(time).getTime();
    const travelTimeMs = userTimeMs - 30 * 60 * 1000;
    // convert that to ISO
    const travelTimeIso = new Date(travelTimeMs).toISOString();

    // 4) Fetch user data from Firestore
    const userDoc = await db
      .collection("users")
      .doc(user_id)
      .collection("workspaces")
      .doc(workspace_id)
      .get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User or workspace not found",
      });
    }

    const userData = userDoc.data();
    const routingAgents = userData.routing_agents || [];

    if (routingAgents.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No routing agents found",
      });
    }

    // 5) Determine which agent(s) can handle the time + 30-min prior
    const availableAgents = [];
    for (const agent of routingAgents) {
      const slots = await getAvailableSlots(agent.calendar_id, dateOnly);

      const mainSlot = hasMatchingSlot(slots, time);
      const travelSlot = hasMatchingSlot(slots, travelTimeIso);

      if (mainSlot && travelSlot) {
        // Agent is free 30 min prior + requested time
        const distance = await getDistance(zipcode, agent.zipcode);
        if (distance !== null) {
          availableAgents.push({ ...agent, distance });
        }
      }
    }

    if (availableAgents.length === 0) {
      return res.status(404).json({
        success: false,
        error:
          "No agents available at the specified time (including 30-min buffer)",
      });
    }

    // 6) Sort by distance and pick the closest agent
    availableAgents.sort((a, b) => a.distance - b.distance);
    const selectedAgent = availableAgents[0];

    // 7) Find (or create) a contact in GHL by phone number
    const locationId = userData.location_id; // e.g. "bd05Y9SlF1EmxJDB9hvR"
    const contactId = await findOrCreateContactByPhone(phoneNumber, locationId);

    // 8) Finally, book the appointment
    const appointment = await createAppointment(
      selectedAgent.calendar_id,
      locationId,
      time,
      contactId
    );

    if (!appointment) {
      return res.status(500).json({
        success: false,
        error: "Failed to create appointment",
      });
    }

    // 9) Return success
    res.json({
      success: true,
      appointment: {
        agent: {
          address: selectedAgent.address,
          distance: selectedAgent.distance,
        },
        phoneNumberUsed: phoneNumber,
        appointmentDetails: appointment,
      },
    });
  } catch (error) {
    console.error("Error in routing webhook:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

module.exports = router;
