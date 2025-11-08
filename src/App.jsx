import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, limit, orderBy, getDocs } from 'firebase/firestore';
import { RefreshCw, CheckCircle, Sunrise, BarChart2, Utensils, Heart, Calendar, XCircle, ChevronLeft, ChevronRight } from 'lucide-react'; // Icons

// --- Global Environment Variables (MUST BE USED) ---
const appId = 'adfit-web-app'; // Placeholder ID
const firebaseConfig = { apiKey: "YOUR_API_KEY", authDomain: "YOUR_AUTH_DOMAIN", projectId: "YOUR_PROJECT_ID", storageBucket: "YOUR_STORAGE_BUCKET", messagingSenderId: "YOUR_MESSAGING_ID", appId: "YOUR_APP_ID" };
const initialAuthToken = null; 

// --- Gemini API Configuration ---
const API_KEY = ""; // Canvas environment handles the key if empty
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;
const MAX_RETRIES = 5;

// --- STRUCTURED PROGRAM SCHEMA (for Training) ---
const PROGRAM_SCHEMA = {
    type: "ARRAY",
    description: "A 14-day training schedule where each object represents a single day, including strength, cardio, and rest days.",
    items: {
        type: "OBJECT",
        properties: {
            "day": { "type": "NUMBER", description: "Day number in the 14-day cycle (1 to 14)." },
            "focus": { "type": "STRING", description: "The primary focus of the day (e.g., 'Upper Body Strength', 'Cardio: Running', 'Rest')." },
            "session_type": { "type": "STRING", description: "Type of session ('Strength', 'Cardio', 'Rest')." },
            "workout_plan": {
                type: "ARRAY",
                description: "List of exercises, only present if session_type is 'Strength' or 'Cardio'. Must contain 5-6 exercises, each with 3-4 sets.",
                items: {
                    type: "OBJECT",
                    properties: {
                        "exercise": { "type": "STRING", description: "The name of the exercise." },
                        "sets": { "type": "NUMBER", description: "The recommended number of sets (must be 3 or 4)." },
                        "reps": { "type": "STRING", description: "The recommended rep range/distance/time, e.g., '8-10', '30 minutes', '3 miles'." },
                        "notes": { "type": "STRING", description: "Specific instruction for the exercise/run, e.g., 'Focus on eccentric', 'Maintain RPE 7/10', 'Warm-up sets needed'." }
                    },
                    "propertyOrdering": ["exercise", "sets", "reps", "notes"]
                }
            }
        },
        "required": ["day", "focus", "session_type"],
        "propertyOrdering": ["day", "focus", "session_type", "workout_plan"]
    }
};

// --- STRUCTURED MEAL PLAN SCHEMA (for Nutrition) ---
const MEAL_PLAN_SCHEMA = {
    type: "ARRAY",
    description: "A seven-day structured meal plan.",
    items: {
        type: "OBJECT",
        properties: {
            "day": { "type": "STRING", description: "The day of the week (e.g., 'Monday')." },
            "meals": {
                type: "ARRAY",
                description: "List of meals for the day.",
                items: {
                    type: "OBJECT",
                    properties: {
                        "meal_type": { "type": "STRING", description: "Breakfast, Lunch, Dinner, Snack." },
                        "description": { "type": "STRING", description: "Detailed description of the meal, including ingredients and estimated portion sizes." },
                        "calories": { "type": "NUMBER", description: "Estimated calories for this meal." }
                    },
                    "propertyOrdering": ["meal_type", "description", "calories"]
                }
            },
            "day_total_calories": { "type": "NUMBER", description: "The total estimated calories for the entire day." },
            "day_total_protein_g": { "type": "NUMBER", description: "The total estimated protein in grams for the entire day." }
        },
        "required": ["day", "meals", "day_total_calories", "day_total_protein_g"],
        "propertyOrdering": ["day", "meals", "day_total_calories", "day_total_protein_g"]
    }
};

// --- Firebase State Management ---
let dbInstance = null;
let authInstance = null;

const App = () => {
    // UI State
    const [sessionsPerWeek, setSessionsPerWeek] = useState(4);
    const [focusAreas, setFocusAreas] = useState("Upper body and running split.");
    const [program, setProgram] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isNutritionLoading, setIsNutritionLoading] = useState(false);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('training'); // 'training', 'wellness', 'nutrition', or 'compliance'
    const [showLogModal, setShowLogModal] = useState(false);
    const [currentDayToLog, setCurrentDayToLog] = useState(null);
    
    // Daily Log Modal State
    const [dailyLogRPE, setDailyLogRPE] = useState('');
    const [dailyLogNotes, setDailyLogNotes] = useState('');
    const [dailyLogWeights, setDailyLogWeights] = useState({});
    const [programFeedback, setProgramFeedback] = useState(''); // State for program refinement

    // Auth State
    const [userId, setUserId] = useState('Loading...');
    const [isAuthReady, setIsAuthReady] = useState(false);
    
    // Data State
    const [history, setHistory] = useState([]); // Training History (Program Logs)
    const [activityLogs, setActivityLogs] = useState({}); // Daily Activity Logs (Keyed by date string)

    // Wellness State
    const [sleepHours, setSleepHours] = useState(8);
    const [saunaChecked, setSaunaChecked] = useState(false);
    const [iceBathChecked, setIceBathChecked] = useState(false);
    const [readingChecked, setReadingChecked] = useState(false);
    const [journalingChecked, setJournalingChecked] = useState(false);
    const [wellnessLogs, setWellnessLogs] = useState([]); // Raw list of wellness logs
    const [wellnessLogsMap, setWellnessLogsMap] = useState({}); // Wellness logs keyed by date

    // Nutrition State
    const [calorieLimit, setCalorieLimit] = useState(2500);
    const [foodLikes, setFoodLikes] = useState('High protein, low sugar. I enjoy chicken, eggs, and sweet potatoes.');
    const [foodDislikes, setFoodDislikes] = useState('I dislike fish and dairy.');
    const [generatedMealPlan, setGeneratedMealPlan] = useState(null);
    const [repeatWeekdays, setRepeatWeekdays] = useState(false); // Mon-Fri Repeat
    const [mealFeedback, setMealFeedback] = useState(''); // Meal Refinement Input
    const [nutritionCompliance, setNutritionCompliance] = useState({}); // Compliance logs


    // --- 1. FIREBASE INITIALIZATION & AUTHENTICATION (Anonymous/Custom Token) ---
    useEffect(() => {
        if (!firebaseConfig) { setUserId('No Config!'); return; }

        try {
            const app = initializeApp(firebaseConfig);
            authInstance = getAuth(app);
            dbInstance = getFirestore(app);

            const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
                let currentUserId;
                if (user) {
                    currentUserId = user.uid;
                } else {
                    // Fallback to anonymous sign-in if no user is present
                    const anonUser = await signInAnonymously(authInstance);
                    currentUserId = anonUser.user.uid;
                }

                setUserId(currentUserId);
                setIsAuthReady(true);
            });

            // Using the corrected initialAuthToken variable
            if (initialAuthToken) {
                signInWithCustomToken(authInstance, initialAuthToken).catch(error => {
                    console.error("Error signing in with custom token, attempting anonymous sign-in:", error);
                    signInAnonymously(authInstance);
                });
            } else if (!authInstance.currentUser) {
                signInAnonymously(authInstance);
            }

            return () => unsubscribe();
        } catch (err) {
            console.error("Error initializing Firebase:", err);
            setUserId('Error!');
            setIsAuthReady(false);
        }
    }, []);

    // Helper functions for Firestore paths
    const getTrainingCollectionPath = useCallback(() => `artifacts/${appId}/users/${userId}/training_data`, [userId]);
    const getWellnessCollectionPath = useCallback(() => `artifacts/${appId}/users/${userId}/wellness_data`, [userId]);
    const getActivityLogCollectionPath = useCallback(() => `artifacts/${appId}/users/${userId}/daily_activity_logs`, [userId]);
    const getNutritionLogCollectionPath = useCallback(() => `artifacts/${appId}/users/${userId}/nutrition_compliance`, [userId]);

    // --- 2. FIRESTORE LISTENERS ---
    
    // 2a. Load and listen for Program History (Latest Program & Configuration)
    useEffect(() => {
        // FIX: Ensure DB, Auth, and UserID are ready before querying
        if (!dbInstance || !isAuthReady || !userId || userId === 'Loading...' || userId === 'Error!') return;

        try {
            const logsCollectionRef = collection(dbInstance, getTrainingCollectionPath());
            const q = query(logsCollectionRef, orderBy("timestamp", "desc"), limit(1));

            const unsubscribe = onSnapshot(q, (snapshot) => {
                if (snapshot.docs.length > 0) {
                    const latestLog = snapshot.docs[0].data();
                    setProgram(latestLog.program);
                    // Set configuration from latest log, use defaults if missing
                    setSessionsPerWeek(latestLog.sessionsPerWeek || 4);
                    setFocusAreas(latestLog.focusAreas || "Upper body and running split.");

                    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    setHistory(logs);
                } else {
                    setProgram(null);
                    setHistory([]);
                }
            }, (err) => {
                console.error("Error fetching training history:", err);
            });

            return () => unsubscribe();
        } catch (err) {
            if (userId !== 'Loading...') console.error("Could not set up training listener:", err.message);
        }
    }, [isAuthReady, userId, getTrainingCollectionPath]);

    // 2b. Load and listen for Daily Activity Logs
    useEffect(() => {
        // FIX: Ensure DB, Auth, and UserID are ready before querying
        if (!dbInstance || !isAuthReady || !userId || userId === 'Loading...' || userId === 'Error!') return;

        try {
            const logsCollectionRef = collection(dbInstance, getActivityLogCollectionPath());
            const q = query(logsCollectionRef, orderBy("date_string", "desc"), limit(30));

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const logsMap = {};
                snapshot.docs.forEach(doc => {
                    const data = doc.data();
                    logsMap[data.date_string] = data; // Key by date for easy lookup
                });
                setActivityLogs(logsMap);
            }, (err) => {
                console.error("Error fetching activity logs:", err);
            });

            return () => unsubscribe();
        } catch (err) {
            if (userId !== 'Loading...') console.error("Could not set up activity log listener:", err.message);
        }
    }, [isAuthReady, userId, getActivityLogCollectionPath]);

    // 2c. Load and listen for Wellness History
    useEffect(() => {
        // FIX: Ensure DB, Auth, and UserID are ready before querying
        if (!dbInstance || !isAuthReady || !userId || userId === 'Loading...' || userId === 'Error!') return;

        try {
            const logsCollectionRef = collection(dbInstance, getWellnessCollectionPath());
            // Fetch more logs for the calendar view
            const q = query(logsCollectionRef, orderBy("timestamp", "desc"), limit(45)); 

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setWellnessLogs(logs);
                
                // Create a map for quick lookup by date string for the calendar
                const logsMap = {};
                logs.forEach(log => {
                    const date = new Date(log.timestamp?.toDate ? log.timestamp.toDate() : log.timestamp);
                    const dateString = date.toISOString().split('T')[0];
                    // Only log the first wellness log of the day for the map
                    if (!logsMap[dateString]) {
                        logsMap[dateString] = log;
                    }
                });
                setWellnessLogsMap(logsMap);

            }, (err) => {
                console.error("Error fetching wellness history:", err);
            });

            return () => unsubscribe();
        } catch (err) {
            if (userId !== 'Loading...') console.error("Could not set up wellness listener:", err.message);
        }
    }, [isAuthReady, userId, getWellnessCollectionPath]);
    
    // 2d. Load and listen for Nutrition Compliance
    useEffect(() => {
        // FIX: Ensure DB, Auth, and UserID are ready before querying
        if (!dbInstance || !isAuthReady || !userId || userId === 'Loading...' || userId === 'Error!') return;

        try {
            const logsCollectionRef = collection(dbInstance, getNutritionLogCollectionPath());
            // Fetch more logs for the calendar view
            const q = query(logsCollectionRef, orderBy("date_string", "desc"), limit(45));

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const logsMap = {};
                snapshot.docs.forEach(doc => {
                    const data = doc.data();
                    logsMap[data.date_string] = data.compliant; // Key by date, store compliance boolean
                });
                setNutritionCompliance(logsMap);
            }, (err) => {
                console.error("Error fetching nutrition compliance:", err);
            });

            return () => unsubscribe();
        } catch (err) {
            if (userId !== 'Loading...') console.error("Could not set up nutrition compliance listener:", err.message);
        }
    }, [isAuthReady, userId, getNutritionLogCollectionPath]);


    // --- 3. FIRESTORE SAVING FUNCTIONS ---
    
    // 3a. Save New 2-Week Program Log
    const saveNewProgram = async (logInput, newProgram, sessions, focus) => {
        if (!dbInstance || !userId || !isAuthReady) return console.error("DB not ready for program save.");
        try {
            const logsCollectionRef = collection(dbInstance, getTrainingCollectionPath());
            // Using setDoc with auto-generated ID to create a new program history entry
            await setDoc(doc(logsCollectionRef), {
                log_input: logInput,
                program: newProgram,
                timestamp: new Date(),
                sessionsPerWeek: sessions,
                focusAreas: focus
            });
            console.log("New 2-week program saved successfully.");
        } catch (e) {
            console.error("Error saving training document: ", e);
            setError(`Could not save new program: ${e.message}`);
        }
    };
    
    // 3b. Save Daily Activity Log (Weight/RPE/Completion)
    const saveDailyActivityLog = async (dayData, rpe, notes, weights) => {
        if (!dbInstance || !userId || !isAuthReady) return console.error("DB not ready for daily activity save.");
        
        const today = new Date();
        const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        try {
            const logsCollectionRef = collection(dbInstance, getActivityLogCollectionPath());
            const logId = dateString; // Use date as the document ID for easy lookup
            
            await setDoc(doc(logsCollectionRef, logId), {
                date_string: dateString,
                day_data: dayData, // Store the planned workout structure
                rpe: rpe,
                notes: notes,
                weights: weights, // Store the logged weights (nested map)
                completed: true,
                timestamp: today
            });
            console.log(`Daily activity log for ${dateString} saved successfully.`);
            setError(null);
            setShowLogModal(false);
            setCurrentDayToLog(null);
        } catch (e) {
            console.error("Error saving daily activity document: ", e);
            setError(`Could not save daily activity: ${e.message}`);
        }
    };

    // 3c. Save Wellness Log
    const saveWellnessLog = async () => {
        if (!dbInstance || !userId || !isAuthReady) return setError("Database or User ID not ready for saving.");

        const logData = {
            sleepHours, sauna: saunaChecked, iceBath: iceBathChecked,
            reading: readingChecked, journaling: journalingChecked,
            timestamp: new Date(),
        };

        try {
            const logsCollectionRef = collection(dbInstance, getWellnessCollectionPath());
            // Using setDoc with auto-generated ID for history tracking
            await setDoc(doc(logsCollectionRef), logData); 
            console.log("Wellness log saved successfully.");
            setError(null);
            
            // Optionally reset inputs after successful save
            setSleepHours(8);
            setSaunaChecked(false);
            setIceBathChecked(false);
            setReadingChecked(false);
            setJournalingChecked(false);

        } catch (e) {
            console.error("Error saving wellness document: ", e);
            setError(`Could not save wellness data: ${e.message}`);
        }
    };
    
    // 3d. Log Nutrition Compliance
    const handleLogNutritionCompliance = async (compliant) => {
        if (!dbInstance || !userId || !isAuthReady) return setError("Database or User ID not ready for saving compliance.");
        
        const today = new Date();
        const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        try {
            const logsCollectionRef = collection(dbInstance, getNutritionLogCollectionPath());
            const logId = dateString; // Use date as the document ID
            
            await setDoc(doc(logsCollectionRef, logId), {
                date_string: dateString,
                compliant: compliant, // true or false
                timestamp: today
            });
            console.log(`Nutrition compliance log for ${dateString} saved: ${compliant}.`);
            setError(null);
        } catch (e) {
            console.error("Error saving nutrition compliance: ", e);
            setError(`Could not save nutrition compliance: ${e.message}`);
        }
    };


    // --- 4. GEMINI API CALLS ---
    
    // 4a. Training Program Generation 
    const generateAdaptiveWorkout = async (sessionsPerWeek, focusAreas, historyLogs, wellnessData) => {
        const wellnessSummary = wellnessData.map(log => {
            const date = new Date(log.timestamp?.toDate ? log.timestamp.toDate() : log.timestamp).toLocaleDateString();
            return `[${date}] Sleep: ${log.sleepHours}h, Sauna: ${log.sauna ? 'Yes' : 'No'}, Ice Bath: ${log.iceBath ? 'Yes' : 'No'}, Reading: ${log.reading ? 'Yes' : 'No'}, Journal: ${log.journaling ? 'Yes' : 'No'}.`;
        }).join('\n');


        const systemInstruction = `You are a world-class, adaptive personal trainer AI. Your task is to analyze the user's desired training frequency, focus areas, workout history, and crucial their **recent wellness data**. Based on this comprehensive analysis, you MUST generate a complete, rolling 2-week training program (14 days).
        
**Program Structure Rules (CRITICAL ADHERENCE):**
1.  **Duration:** MUST be exactly 14 days long (an array of 14 objects).
2.  **Frequency Match:** The total number of Strength/Cardio sessions in the 14 days MUST correspond **EXACTLY** to ${sessionsPerWeek} sessions per week (i.e., ${sessionsPerWeek * 2} sessions total, with the remainder being 'Rest').
3.  **Focus Match:** The types of sessions selected (Strength, Cardio, etc.) MUST directly reflect and be proportionate to the user's stated focus areas: "${focusAreas}".
4.  **Content:** Workout days MUST contain **5 to 6 exercises**. Each exercise MUST have **3 or 4 sets**.
5.  **Units:** **All weight units MUST be in kilograms (KG).**

**Adaptation Rules:**
1.  **Performance Log (From History):** Analyze past workout logs (RPE, weights, notes) to suggest progressive overload or deloading.
2.  **Wellness Data:** If recent recovery data (e.g., average sleep < 7 hours, low recovery habits) suggests low readiness, you MUST recommend **lower intensity/volume** or add an extra rest/active recovery day in the first week.

Output Format: MUST be a JSON array of 14 objects based on the provided JSON schema. DO NOT include any text or commentary outside the JSON block.`;

        // Extracting only the latest program log for context
        const latestProgramLog = historyLogs.length > 0 ? historyLogs[0] : null;

        const userQuery = `
        Desired Sessions per Week: ${sessionsPerWeek}
        Desired Focus Areas: ${focusAreas}
        
        Recent 7-Day Wellness/Recovery Data (CRITICAL DATA FOR READINESS):
        ---
        ${wellnessSummary || "No recent wellness logs available, treat readiness as moderate."}
        ---

        Latest 14-Day Program for Context:
        ---
        ${latestProgramLog?.program ? JSON.stringify(latestProgramLog.program) : "No previous program available yet. Create a standard progressive 2-week plan."}
        ---
        Generate the complete 14-day adaptive program now.
        `;

        const placeholderLastLog = "User is generating a new program based on configuration. Adapt the program based on wellness data and history, not on a specific last log entry.";

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: PROGRAM_SCHEMA,
                temperature: 0.7
            }
        };

        for (let i = 0; i < MAX_RETRIES; i++) {
            try {
                const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const result = await response.json();
                const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
                const program = JSON.parse(jsonText);

                if (!Array.isArray(program) || program.length !== 14) {
                     throw new Error(`AI returned ${program.length} days, expected 14 days for a 2-week program.`);
                }
                
                return { program, logInput: placeholderLastLog, sources: [] }; 
            } catch (error) {
                console.error(`Training attempt ${i + 1} failed:`, error);
                if (i === MAX_RETRIES - 1) throw new Error("Failed to generate training program after multiple retries.");
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
            }
        }
    };
    
    // 4b. Gemini API Call (Training Refinement) 
    const refineProgram = async (currentProgram, feedback) => {
        const systemInstruction = `You are an expert personal trainer AI. The user has provided feedback to refine their existing 14-day training program. Your task is to apply the user's feedback (e.g., "Change Monday's run to sprints") directly to the existing JSON program.
        
You MUST return the **full, modified 14-day JSON array**.
Ensure you maintain the existing structure (14 days, same number of sessions/week) and adhere to the exercise count and set count rules (5-6 exercises, 3-4 sets) where applicable. All weight units MUST remain in **kilograms (KG)**.
Output Format: MUST be a JSON array of 14 objects based on the provided JSON schema. DO NOT include any text or commentary outside the JSON block.`;

        const userQuery = `
        User Feedback: ${feedback}
        
        Current 14-Day Program (JSON to be modified):
        ---
        ${JSON.stringify(currentProgram)}
        ---
        
        Apply the feedback and return the complete, revised 14-day program JSON.
        `;
        
        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: PROGRAM_SCHEMA,
                temperature: 0.5
            }
        };

        for (let i = 0; i < MAX_RETRIES; i++) {
            try {
                const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const result = await response.json();
                    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    const program = JSON.parse(jsonText);

                    if (!Array.isArray(program) || program.length !== 14) {
                         throw new Error(`AI returned ${program.length} days, expected 14 days for a 2-week program.`);
                    }
                    
                    return { program: program };
                } catch (error) {
                    console.error(`Program refinement attempt ${i + 1} failed:`, error);
                    if (i === MAX_RETRIES - 1) throw new Error("Failed to refine program after multiple retries.");
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                }
            }
        };
        
        // 4c. Gemini API Call (Nutrition)
        const generateMealPlan = async (calorieTarget, likes, dislikes, repeatWeekdays) => {
            const systemInstruction = `You are a professional nutritionist AI. Your task is to create a complete, structured 7-day meal plan tailored to the user's specific calorie goal and food preferences/restrictions.

The plan MUST meet the following criteria:
1.  **7 Days:** Provide a plan for seven consecutive days.
2.  **Calorie Compliance:** The total daily calories MUST be as close as possible to the user's target. Provide the estimated total for each day.
3.  **Preferences:** Strictly use foods from the 'Wants/Likes' list and strictly avoid all foods from the 'Dislikes/Exclude' list.
4.  **Structure:** Each day should include Breakfast, Lunch, Dinner, and optionally 1-2 Snacks.
5.  **Units:** All food quantities and measurements MUST be detailed in **grams (g)** or **milliliters (ml)** (Australian metric system).
6.  **Nutrient Tracking:** You MUST provide the **day_total_protein_g** (total estimated protein in grams) for each day.
${repeatWeekdays ? "7. **Weekday Repetition:** The meal plan structure, meals, and quantities for **Monday, Tuesday, Wednesday, Thursday, and Friday MUST be identical** to simplify preparation." : "7. **Variety:** Ensure maximum variety across all 7 days."}
8.  **Output Format:** MUST be a JSON array of 7 objects based on the provided JSON schema. DO NOT include any text or commentary outside the JSON block.`;

            const userQuery = `
            User's Daily Calorie Target: ${calorieTarget} calories.
            User's Wants/Likes: ${likes}.
            User's Dislikes/Exclude: ${dislikes}.

            Generate the 7-day adaptive meal plan now.
            `;

            const payload = {
                contents: [{ parts: [{ text: userQuery }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: MEAL_PLAN_SCHEMA,
                    temperature: 0.7
                }
            };

            for (let i = 0; i < MAX_RETRIES; i++) {
                try {
                    const response = await fetch(API_URL, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                    });
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                    const result = await response.json();
                    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    const plan = JSON.parse(jsonText);

                    if (!Array.isArray(plan) || plan.length !== 7) {
                         throw new Error(`AI returned ${plan.length} days, expected 7 days for a 1-week meal plan.`);
                    }
                    
                    return { plan: plan, sources: [] };
                } catch (error) {
                    console.error(`Nutrition attempt ${i + 1} failed:`, error);
                    if (i === MAX_RETRIES - 1) throw new Error("Failed to generate meal plan after multiple retries.");
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                }
            }
        };
        
        // 4d. Gemini API Call (Meal Refinement) 
        const refineMealPlan = async (currentPlan, feedback) => {
            const systemInstruction = `You are an expert nutritionist AI. The user has provided feedback to refine their existing 7-day meal plan. Your task is to apply the user's feedback (e.g., "change Monday's breakfast to X") directly to the existing JSON plan.
            
You MUST return the **full, modified 7-day JSON array**.
Ensure you maintain the same structure and adhere to the original calorie target as closely as possible.
All measurements MUST remain in grams (g) or milliliters (ml). You MUST also recalculate and include the **day_total_protein_g** and **day_total_calories** for the modified days.
Output Format: MUST be a JSON array of 7 objects based on the provided JSON schema. DO NOT include any text or commentary outside the JSON block.`;

            const userQuery = `
            User Feedback: ${feedback}
            
            Current 7-Day Meal Plan (JSON to be modified):
            ---
            ${JSON.stringify(currentPlan)}
            ---
            
            Apply the feedback and return the complete, revised 7-day plan JSON.
            `;
            
            const payload = {
                contents: [{ parts: [{ text: userQuery }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: MEAL_PLAN_SCHEMA,
                    temperature: 0.5
                }
            };

            for (let i = 0; i < MAX_RETRIES; i++) {
                try {
                    const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                    const result = await response.json();
                    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    const plan = JSON.parse(jsonText);

                    if (!Array.isArray(plan) || plan.length !== 7) {
                         throw new Error(`AI returned ${plan.length} days, expected 7 days for a 1-week meal plan.`);
                    }
                    
                    return { plan: plan };
                } catch (error) {
                    console.error(`Meal refinement attempt ${i + 1} failed:`, error);
                    if (i === MAX_RETRIES - 1) throw new Error("Failed to refine meal plan after multiple retries.");
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                }
            }
        };


        // --- 5. MAIN HANDLERS ---
        
        // 5a. Training Program Handler
        const handleGenerateWorkout = async () => {
            if (!isAuthReady || userId === 'Loading...') { setError('Please wait for the app to connect to the database.'); return; }
            if (sessionsPerWeek < 1 || sessionsPerWeek > 7) { setError('Sessions per week must be between 1 and 7.'); return; }
            if (!focusAreas.trim()) { setError('Please specify your focus areas (e.g., Upper Body, Cardio).'); return; }

            // Clear previous state and show loading
            setIsLoading(true);
            setError(null);
            setProgram(null); // Clear program while loading

            try {
                // 1. Fetch History
                const logsCollectionRef = collection(dbInstance, getTrainingCollectionPath());
                const historyQuery = query(logsCollectionRef, orderBy("timestamp", "desc"), limit(1));
                const historySnapshot = await getDocs(historyQuery);
                const historyLogs = historySnapshot.docs.map(doc => doc.data());
                
                // 2. Generate new Program (now including config and wellness data)
                const { program: newProgram, logInput: placeholderLastLog } = await generateAdaptiveWorkout(
                    sessionsPerWeek, 
                    focusAreas.trim(),
                    historyLogs, 
                    wellnessLogs // Pass the last 7 days of wellness logs
                );

                // 3. Update state and save
                setProgram(newProgram);
                await saveNewProgram(placeholderLastLog, newProgram, sessionsPerWeek, focusAreas.trim());

            } catch (err) {
                console.error("Workout generation failed:", err);
                setError(`Could not generate adaptive program. ${err.message}`);
                setProgram(null);
            } finally {
                setIsLoading(false);
            }
        };
        
        // 5b. Program Refinement Handler
        const handleProgramRefinement = async () => {
            if (!program) { setError("Please generate a program first before providing feedback."); return; }
            if (!programFeedback.trim()) { setError("Please enter your feedback (e.g., 'Change Monday's run to sprints')."); return; }

            setIsLoading(true);
            setError(null);

            try {
                const { program: refinedProgram } = await refineProgram(program, programFeedback.trim());
                setProgram(refinedProgram); // Overwrite with refined plan
                setProgramFeedback(''); // Clear feedback input
            } catch (err) {
                console.error("Program refinement failed:", err);
                setError(`Could not refine program. ${err.message}`);
            } finally {
                setIsLoading(false);
            }
        };


        // 5c. Daily Log Modal Opener (Combined View/Log on click)
        const handleOpenLogModal = (dayData) => {
            if (dayData.session_type === 'Rest') return;

            setCurrentDayToLog(dayData);
            
            // Initialize weights map only for Strength sessions
            if (dayData.session_type === 'Strength') {
                const initialWeights = {};
                dayData.workout_plan?.forEach((exercise, exerciseIndex) => {
                    const numSets = exercise.sets || 3;
                    // Initialize the array for each exercise with empty strings for each set
                    initialWeights[exerciseIndex] = Array.from({ length: numSets }, () => '');
                });
                setDailyLogWeights(initialWeights);
            } else {
                 // Clear weights for Cardio/Other sessions
                setDailyLogWeights({});
            }

            setDailyLogRPE('');
            setDailyLogNotes('');
            setShowLogModal(true);
        };

        // 5d. Daily Log Submission
        const handleDailyLogSubmit = async (e) => {
            e.preventDefault();
            if (!currentDayToLog) return;
            
            // RPE validation for non-Rest days
            if (currentDayToLog.session_type !== 'Rest' && (!dailyLogRPE || dailyLogRPE < 1 || dailyLogRPE > 10)) {
                return setError("Please enter a valid RPE (1-10) for your workout.");
            }

            setIsLoading(true);
            setError(null);

            try {
                await saveDailyActivityLog(
                    currentDayToLog, 
                    dailyLogRPE, 
                    dailyLogNotes, 
                    currentDayToLog.session_type === 'Strength' ? dailyLogWeights : {} // Only save weights for strength
                );
            } catch (err) {
                console.error("Submission failed:", err);
                setError(`Failed to submit log: ${e.message}`);
            } finally {
                setIsLoading(false);
            }
        };

        // 5e. Nutrition Plan Handler
        const handleGenerateMealPlan = async () => {
            if (!isAuthReady || userId === 'Loading...') { setError('Please wait for the app to connect to the database.'); return; }
            if (calorieLimit < 1000 || (!foodLikes.trim() && !foodDislikes.trim())) { setError('Please set a realistic Calorie Limit (min 1000) and enter at least one preference or dislike.'); return; }

            setIsNutritionLoading(true);
            setError(null);
            setGeneratedMealPlan(null);

            try {
                const { plan: newMealPlan } = await generateMealPlan(calorieLimit, foodLikes.trim(), foodDislikes.trim(), repeatWeekdays);
                setGeneratedMealPlan(newMealPlan);
            } catch (err) {
                console.error("Meal plan generation failed:", err);
                setError(`Could not generate meal plan. ${err.message}`);
            } finally {
                setIsNutritionLoading(false);
            }
        };
        
        // 5f. Meal Refinement Handler
        const handleMealRefinement = async () => {
            if (!generatedMealPlan) { setError("Please generate a meal plan first before providing feedback."); return; }
            if (!mealFeedback.trim()) { setError("Please enter your feedback (e.g., 'Change Tuesday's lunch to a chicken salad')."); return; }

            setIsNutritionLoading(true);
            setError(null);

            try {
                const { plan: refinedPlan } = await refineMealPlan(generatedMealPlan, mealFeedback.trim());
                setGeneratedMealPlan(refinedPlan); // Overwrite with refined plan
                setMealFeedback(''); // Clear feedback input
            } catch (err) {
                console.error("Meal refinement failed:", err);
                setError(`Could not refine meal plan. ${err.message}`);
            } finally {
                setIsNutritionLoading(false);
            }
        };

        // 5g. Sign Out Handler
        const handleSignOut = async () => {
            if (authInstance) {
                try {
                    // Anonymous sign-in means signing out just clears the current session,
                    // and the onAuthStateChanged listener will immediately sign them back in anonymously
                    // with a new ID, effectively resetting their local user data.
                    await signOut(authInstance);
                    setError(null);
                } catch (error) {
                    console.error("Error signing out:", error);
                    setError("Failed to sign out. Please try again.");
                }
            }
        };

        // --- 6. COMPONENTS ---

        const ProgramView = ({ program, activityLogs }) => {
            const todayDateString = new Date().toISOString().split('T')[0];
            const today = new Date();
            const startDay = today.getDate(); 

            return (
                <div id="program-view" className="space-y-6">
                    <h3 className="text-xl font-bold text-gray-700">14-Day Adaptive Program</h3>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
                        {program.map((dayData, index) => {
                            const date = new Date();
                            date.setDate(startDay + index); 
                            
                            const dateString = date.toISOString().split('T')[0];
                            const isCompleted = activityLogs[dateString]?.completed || false;
                            const isToday = dateString === todayDateString;
                            const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });

                            return (
                                // Add cursor pointer to make it clear the box is clickable
                                <div 
                                    key={index} 
                                    onClick={dayData.session_type !== 'Rest' ? () => handleOpenLogModal(dayData) : null}
                                    className={`p-3 rounded-xl shadow-md border relative flex flex-col min-h-[150px] transition transform ${dayData.session_type !== 'Rest' ? 'cursor-pointer hover:shadow-lg bg-white hover:scale-[1.02]' : 'cursor-default bg-gray-50'} ${isToday ? 'border-4 border-green-500 ring-2 ring-green-200' : 'border-gray-200'}`}
                                >
                                    
                                    {isCompleted && (
                                        <CheckCircle className="absolute top-2 right-2 w-5 h-5 text-green-600" />
                                    )}

                                    <div className="text-sm font-bold mb-1 flex justify-between items-start text-gray-800">
                                        <span>{dayName} ({date.getDate()})</span>
                                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${dayData.session_type === 'Rest' ? 'bg-gray-400 text-gray-900' : dayData.session_type === 'Cardio' ? 'bg-green-200 text-green-900' : 'bg-green-500 text-white'}`}>
                                            {dayData.session_type}
                                        </span>
                                    </div>
                                    <p className="text-xs font-semibold mb-2 text-gray-600">{dayData.focus}</p>
                                    
                                    {dayData.session_type !== 'Rest' && (
                                        <>
                                        <ul className="text-xs space-y-1 mt-1 flex-grow overflow-hidden text-gray-700">
                                            {dayData.workout_plan && dayData.workout_plan.slice(0, 3).map((item, itemIndex) => (
                                                <li key={itemIndex} className="truncate" title={item.notes}>
                                                    <span className="font-medium">{item.exercise}</span>: {item.sets}x{item.reps}
                                                </li>
                                            ))}
                                            {dayData.workout_plan?.length > 3 && <li className="italic text-gray-500">...and {dayData.workout_plan.length - 3} more.</li>}
                                            {dayData.workout_plan?.length === 0 && <li className="text-gray-500 italic">Plan details missing.</li>}
                                        </ul>
                                        <div className="mt-2 text-xs font-bold text-center text-gray-500 pt-1 border-t border-gray-100">
                                            {isCompleted ? 'LOGGED (Click to Review)' : 'CLICK TO LOG/VIEW'}
                                        </div>
                                        </>
                                    )}
                                    {dayData.session_type === 'Rest' && (
                                        <p className="text-xs text-gray-500 italic mt-auto">Recovery Day.</p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        };

        const DailyLogModal = ({ dayData, onClose, isLoading }) => {
            if (!dayData) return null;
            
            const isStrength = dayData.session_type === 'Strength';

            // Updates the weight for a specific set within a specific exercise
            const handleSetWeightChange = (exerciseIndex, setIndex, value) => {
                const newWeightValue = value === '' ? '' : Number(value);
                setDailyLogWeights(prev => ({
                    ...prev,
                    [exerciseIndex]: prev[exerciseIndex].map((w, sIdx) => sIdx === setIndex ? newWeightValue : w)
                }));
            };
            
            // Determine headers based on the planned sets
            const setHeaders = Array.from({ length: 4 }, (_, i) => `Set ${i + 1}`); // Default max sets to 4 for headers

            return (
                <div className="fixed inset-0 bg-gray-900 bg-opacity-70 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl p-6 space-y-4">
                        <h3 className="text-2xl font-bold text-gray-800 border-b pb-2 flex items-center">
                            <BarChart2 className="w-6 h-6 mr-2 text-green-600" />
                            {isStrength ? 'Log Strength Workout' : 'Log Cardio/Activity'}
                            : Day {dayData.day} - {dayData.focus}
                        </h3>
                        
                        <form onSubmit={handleDailyLogSubmit} className="space-y-4">
                            
                            {/* Planned Workout Details & Granular Logging */}
                            {dayData.workout_plan?.length > 0 && (
                                <div className="bg-gray-50 p-4 rounded-lg max-h-96 overflow-y-auto space-y-4 border border-gray-200">
                                    <h4 className="font-semibold text-lg text-green-700">Planned Session & Your Logged Performance (KG)</h4>
                                    
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-100">
                                            <tr>
                                                <th className="py-2 px-3 text-left text-xs font-medium text-gray-500 uppercase w-1/4">Exercise</th>
                                                <th className="py-2 px-3 text-left text-xs font-medium text-gray-500 uppercase w-1/6">Plan (Sets x Reps)</th>
                                                {isStrength && setHeaders.map((header, i) => (
                                                    <th key={i} className="py-2 px-3 text-center text-xs font-medium text-gray-500 uppercase">{header} (KG)</th>
                                                ))}
                                                {!isStrength && (
                                                    <th className="py-2 px-3 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
                                                )}
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {dayData.workout_plan.map((item, exerciseIndex) => {
                                                const itemNumSets = item.sets || 3;
                                                
                                                return (
                                                    <tr key={exerciseIndex}>
                                                        <td className="py-2 px-3 whitespace-nowrap text-sm font-medium text-gray-800">{item.exercise}</td>
                                                        <td className="py-2 px-3 whitespace-nowrap text-sm text-gray-600">{itemNumSets}x{item.reps}</td>
                                                        
                                                        {/* GRANULAR WEIGHT LOGGING (Only for Strength) */}
                                                        {isStrength && Array.from({ length: itemNumSets }).map((_, setIndex) => (
                                                            <td key={setIndex} className="py-1 px-3 text-center">
                                                                <input
                                                                    type="number"
                                                                    placeholder="KG"
                                                                    step="0.5"
                                                                    // Safely access the nested array for weights
                                                                    value={dailyLogWeights[exerciseIndex]?.[setIndex] || ''} 
                                                                    onChange={(e) => handleSetWeightChange(exerciseIndex, setIndex, e.target.value)}
                                                                    className="w-full p-1 border border-gray-300 rounded-md text-sm text-center focus:ring-green-500 focus:border-green-500"
                                                                />
                                                            </td>
                                                        ))}
                                                        {/* NOTES/INFO FOR CARDIO */}
                                                        {!isStrength && (
                                                            <td className="py-2 px-3 text-sm text-gray-500 italic">{item.notes}</td>
                                                        )}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                            
                            {/* RPE Input (Required for both Strength and Cardio) */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="md:col-span-1">
                                    <label htmlFor="log-rpe" className="block text-sm font-medium text-gray-700 mb-1">RPE (1-10) <span className="text-red-500">*</span></label>
                                    <input
                                        type="number" id="log-rpe" min="1" max="10" 
                                        value={dailyLogRPE}
                                        onChange={(e) => setDailyLogRPE(e.target.value)}
                                        placeholder="e.g. 8"
                                        required 
                                        className="w-full p-2 border border-gray-300 rounded-md focus:ring-green-500 focus:border-green-500"
                                    />
                                </div>

                                {/* Notes */}
                                <div className="md:col-span-2">
                                    <label htmlFor="log-notes" className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
                                    <textarea
                                        id="log-notes" rows="2"
                                        value={dailyLogNotes}
                                        onChange={(e) => setDailyLogNotes(e.target.value)}
                                        placeholder={isStrength ? "e.g., Felt strong today, increased squat weight by 5kg. Need to focus on bench form." : "e.g., Run felt easy, maintained a 5:00/km pace. Feeling good for tomorrow."}
                                        className="w-full p-2 border border-gray-300 rounded-md focus:ring-green-500 focus:border-green-500 resize-none text-sm"
                                    />
                                </div>
                            </div>

                            {/* Buttons */}
                            <div className="flex justify-end space-x-3 pt-2">
                                <button
                                    type="button" onClick={onClose}
                                    className="px-4 py-2 text-gray-600 bg-gray-200 rounded-lg hover:bg-gray-300 transition duration-150"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit" disabled={isLoading}
                                    className={`px-4 py-2 font-bold text-white rounded-lg transition duration-150 ${isLoading ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700'}`}
                                >
                                    {isLoading ? 'Saving...' : 'Mark Day as Complete'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            );
        };

        const HistoryList = ({ history }) => (
            <div id="history-list" className="space-y-4">
                {history.length === 0 ? (
                    <p className="text-gray-500 italic" id="empty-history-message">Your program history will appear here after you generate and save your first plan.</p>
                ) : (
                    history.map(log => {
                        const logDate = new Date(log.timestamp?.toDate ? log.timestamp.toDate() : log.timestamp).toLocaleDateString('en-US', {
                            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                        });

                        const strengthDays = log.program?.filter(d => d.session_type === 'Strength').length || 0;
                        const cardioDays = log.program?.filter(d => d.session_type === 'Cardio').length || 0;

                        return (
                            <div key={log.id} className='p-4 bg-white shadow-md rounded-xl border border-gray-200'>
                                <p className="text-xs font-semibold text-gray-500">{logDate} - Log ID: {log.id.substring(0, 8)}...</p>
                                <p className="mt-2 text-sm font-medium text-gray-700">Program Summary:</p>
                                <div className="mt-1 text-sm text-gray-600 bg-gray-50 p-2 rounded-lg">
                                    <span className="font-semibold text-green-600">{strengthDays} Strength Days</span>, <span className="font-semibold text-green-600">{cardioDays} Cardio Days</span>.
                                    <span className="block mt-1 text-xs text-gray-500">Config: {log.sessionsPerWeek} sessions/wk, Focus: {log.focusAreas}</span>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        );
        
        const WellnessTracker = () => {
            const booleanLog = (value) => value ? 'Yes' : 'No';

            return (
                <div className="space-y-8">
                    <div className="p-6 bg-white rounded-xl border border-gray-200 shadow-md">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center"><Heart className="w-6 h-6 mr-2 text-cyan-600" /> Daily Wellness Log</h2>
                        <p className="text-sm text-gray-600 mb-6">Log your recovery and habits today to help the AI understand your overall readiness.</p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Sleep Hours */}
                            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                                <label htmlFor="sleep-hours" className="block text-sm font-medium text-gray-700 mb-2">Sleep Hours Last Night</label>
                                <input
                                    type="number" id="sleep-hours" min="0" max="14" step="0.5"
                                    value={sleepHours}
                                    onChange={(e) => setSleepHours(Number(e.target.value))}
                                    className="w-full p-2 border border-gray-300 rounded-md text-lg focus:ring-cyan-500 focus:border-cyan-500"
                                />
                            </div>

                            {/* Checkbox Inputs */}
                            <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                                <label className="block text-sm font-medium text-gray-700 mb-3">Today's Habits</label>
                                {[
                                    { label: "Sauna", state: saunaChecked, setter: setSaunaChecked },
                                    { label: "Ice Bath", state: iceBathChecked, setter: setIceBathChecked },
                                    { label: "Reading", state: readingChecked, setter: setReadingChecked },
                                    { label: "Journalling", state: journalingChecked, setter: setJournalingChecked },
                                ].map(({ label, state, setter }) => (
                                    <div key={label} className="flex items-center justify-between">
                                        <span className="text-base text-gray-800">{label}</span>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" checked={state} onChange={() => setter(!state)} className="sr-only peer" />
                                            <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-600"></div>
                                        </label>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <button
                            onClick={saveWellnessLog}
                            disabled={!isAuthReady}
                            className={`w-full mt-6 py-3 px-6 rounded-lg shadow-md text-lg font-bold text-white transition duration-150 ease-in-out ${!isAuthReady ? 'bg-gray-400' : 'bg-cyan-600 hover:bg-cyan-700 focus:ring-4 focus:ring-cyan-500'}`}
                        >
                            Save Today's Wellness Log
                        </button>
                    </div>
                    
                    {/* Wellness History Section */}
                    <div className="pt-6 border-t border-gray-200">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4">Wellness History (<span className="text-cyan-600">{wellnessLogs.length}</span> Logs)</h2>
                        <div className="space-y-3">
                            {wellnessLogs.length === 0 ? (
                                <p className="text-gray-500 italic">No wellness logs recorded yet.</p>
                            ) : (
                                wellnessLogs.map(log => (
                                    <div key={log.id} className="p-3 bg-white shadow-sm rounded-xl border border-cyan-100 text-sm">
                                        <p className="text-xs font-semibold text-gray-500 mb-1">
                                            {new Date(log.timestamp?.toDate ? log.timestamp.toDate() : log.timestamp).toLocaleDateString()}
                                        </p>
                                        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-gray-800">
                                            <span className="col-span-1"><span className="font-medium text-cyan-600">Sleep:</span> {log.sleepHours}h</span>
                                            <span className="col-span-1"><span className="font-medium text-gray-700">Sauna:</span> {booleanLog(log.sauna)}</span>
                                            <span className="col-span-1"><span className="font-medium text-gray-700">Ice Bath:</span> {booleanLog(log.iceBath)}</span>
                                            <span className="col-span-1"><span className="font-medium text-gray-700">Reading:</span> {booleanLog(log.reading)}</span>
                                            <span className="col-span-1"><span className="font-medium text-gray-700">Journal:</span> {booleanLog(log.journaling)}</span>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            );
        };

        const MealPlanView = ({ plan, nutritionCompliance }) => {
            const today = new Date(); // Define today here
            const todayDateString = today.toISOString().split('T')[0];
            
            // Helper function to get the date string for a given day name
            const getDateStringForDay = (dayName) => {
                const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const currentDayIndex = today.getDay(); // 0 (Sun) to 6 (Sat)
                const targetDayIndex = daysOfWeek.indexOf(dayName);
                
                if (targetDayIndex === -1) return null;

                let offset = targetDayIndex - currentDayIndex;
                
                // Adjust offset to ensure we land on the next occurrence of that day (up to 6 days ahead)
                if (offset < 0) {
                    offset += 7;
                }

                const targetDate = new Date(today);
                targetDate.setDate(today.getDate() + offset);

                return targetDate.toISOString().split('T')[0];
            };

            return (
                <div className="space-y-6">
                    {plan.map(dayData => {
                        const logDateString = getDateStringForDay(dayData.day);
                        
                        const isToday = logDateString === todayDateString;
                        const complianceStatus = nutritionCompliance[logDateString];
                        const isCompliant = complianceStatus === true;
                        const isNonCompliant = complianceStatus === false;

                        const complianceButtonText = isCompliant
                            ? 'Compliant'
                            : isNonCompliant
                            ? 'Non-Compliant'
                            : 'Log Compliance';

                        return (
                            <div key={dayData.day} className="p-4 bg-white rounded-xl border border-red-200 shadow-lg">
                                <h4 className="text-lg font-bold text-red-600 flex justify-between items-center border-b pb-2 mb-2">
                                    {dayData.day}
                                    <div className="text-sm font-semibold text-red-500 flex space-x-3">
                                        <span className="font-medium">Cals: ~{dayData.day_total_calories}</span>
                                        <span className="font-medium">Protein: ~{dayData.day_total_protein_g}g</span> 
                                    </div>
                                </h4>
                                <ul className="mt-2 space-y-3">
                                    {dayData.meals.map((meal, index) => (
                                        <li key={index} className="border-l-4 border-red-400 pl-3 text-gray-800">
                                            <p className="font-semibold text-gray-800">{meal.meal_type} ({meal.calories} Cal)</p>
                                            <p className="text-sm text-gray-600">{meal.description}</p>
                                        </li>
                                    ))}
                                </ul>

                                {/* Compliance Status and Buttons */}
                                <div className="mt-4 pt-3 border-t border-red-100 flex justify-between items-center">
                                    <div className={`px-3 py-1 text-sm font-bold text-white rounded-lg min-w-[120px] text-center ${isCompliant ? 'bg-green-600' : isNonCompliant ? 'bg-red-600' : 'bg-gray-500'}`}>
                                        {complianceButtonText}
                                    </div>

                                    {isToday && !isCompliant && !isNonCompliant && (
                                        <div className="flex space-x-2">
                                            <button
                                                onClick={() => handleLogNutritionCompliance(true)}
                                                className={`px-3 py-1 text-sm font-bold text-white rounded-lg transition duration-150 bg-green-500 hover:bg-green-600`}
                                            >
                                                On Track
                                            </button>
                                            <button
                                                onClick={() => handleLogNutritionCompliance(false)}
                                                className={`px-3 py-1 text-sm font-bold text-white rounded-lg transition duration-150 bg-red-500 hover:bg-red-600`}
                                            >
                                                Off Track
                                            </button>
                                        </div>
                                    )}
                                    {!isToday && logDateString && (isCompliant || isNonCompliant) && (
                                        <span className="text-xs text-gray-500">Logged on {new Date(logDateString).toLocaleDateString()}</span>
                                    )}
                                    {!isToday && logDateString && !isCompliant && !isNonCompliant && (
                                        <span className="text-xs text-gray-500">Log compliance on {new Date(logDateString).toLocaleDateString()}</span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            );
        };
        
        const NutritionTracker = () => (
            <div className="space-y-8">
                <div className="p-6 bg-white rounded-xl border border-gray-200 shadow-md">
                    <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center"><Utensils className="w-6 h-6 mr-2 text-red-600" /> 7-Day Meal Plan Generator</h2>
                    <p className="text-sm text-gray-600 mb-6">Generate a new plan tailored to your needs and calorie targets. All measurements are in grams/ml.</p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4 items-start"> {/* Changed items-end to items-start for label alignment */}
                        {/* Calorie Limit */}
                        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                            <label htmlFor="calorie-limit" className="block text-sm font-medium text-gray-700 mb-2">Daily Calorie Target</label>
                            <input
                                type="number" id="calorie-limit" min="1000" step="100"
                                value={calorieLimit}
                                onChange={(e) => setCalorieLimit(Number(e.target.value))}
                                className="w-full p-2 border border-gray-300 rounded-md text-lg focus:ring-red-500 focus:border-red-500"
                            />
                        </div>

                        {/* Preferences */}
                        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 col-span-2 grid grid-cols-2 gap-4">
                            {/* Wants / Likes */}
                            <div>
                                <label htmlFor="food-likes" className="block text-sm font-medium text-gray-700 mb-2">Wants / Likes</label>
                                <textarea
                                    id="food-likes" rows="3"
                                    value={foodLikes}
                                    onChange={(e) => setFoodLikes(e.target.value)} // FIX APPLIED
                                    placeholder="e.g., High protein, low carb. I enjoy pasta and sweet potatoes."
                                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-red-500 focus:border-red-500 resize-none text-sm"
                                />
                            </div>
                            
                            {/* Dislikes / Exclude */}
                            <div>
                                <label htmlFor="food-dislikes" className="block text-sm font-medium text-gray-700 mb-2">Dislikes / Exclude</label>
                                <textarea
                                    id="food-dislikes" rows="3"
                                    value={foodDislikes}
                                    onChange={(e) => setFoodDislikes(e.target.value)} // FIX APPLIED
                                    placeholder="e.g., I dislike fish. Exclude all dairy and nuts."
                                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-red-500 focus:border-red-500 resize-none text-sm"
                                />
                            </div>
                        </div>
                    </div>
                    
                    {/* Repeat Weekdays Checkbox */}
                    <div className="flex items-center justify-start mb-6">
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" checked={repeatWeekdays} onChange={() => setRepeatWeekdays(!repeatWeekdays)} className="sr-only peer" />
                            <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-red-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                            <span className="ms-3 text-sm font-medium text-gray-800">Repeat Meals Monday - Friday (Meal Prep Friendly)</span>
                        </label>
                    </div>


                    <button
                        onClick={handleGenerateMealPlan}
                        disabled={isNutritionLoading || !isAuthReady || calorieLimit < 1000 || (!foodLikes.trim() && !foodDislikes.trim())}
                        className={`w-full flex justify-center items-center py-3 px-6 rounded-lg shadow-lg text-lg font-bold text-white transition duration-150 ease-in-out ${isNutritionLoading || !isAuthReady || calorieLimit < 1000 || (!foodLikes.trim() && !foodDislikes.trim()) ? 'bg-gray-400 disabled:shadow-none' : 'bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-4 focus:ring-red-500 focus:ring-opacity-70'}`}
                    >
                        {isNutritionLoading ? (
                            <>
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                                Generating 7-Day Meal Plan...
                            </>
                        ) : (
                            "Generate New Meal Plan"
                        )}
                    </button>
                </div>
                
                {/* Meal Plan Output */}
                <div className="pt-6 border-t border-gray-200">
                    <h3 className="text-2xl font-bold text-gray-800 mb-4">Generated Meal Plan</h3>
                    <div id="meal-output" className="bg-gray-50 p-6 rounded-xl border border-gray-200 min-h-[100px]">
                        {error && activeTab === 'nutrition' && (
                            <div className="bg-red-100 border border-red-500 text-red-700 px-4 py-3 rounded relative" role="alert">
                                <strong className="font-bold">Error:</strong>
                                <span className="block sm:inline ml-2">{error}</span>
                            </div>
                        )}
                        {!error && !generatedMealPlan && !isNutritionLoading && (
                            <p className="text-gray-500 italic">Set your calorie target and preferences and click 'Generate' to create your customized 7-day meal plan.</p>
                        )}
                        {generatedMealPlan && <MealPlanView plan={generatedMealPlan} nutritionCompliance={nutritionCompliance} />}
                    </div>
                </div>
                
                {/* Meal Refinement/Feedback Section */}
                {generatedMealPlan && (
                    <div className="pt-6 border-t border-gray-200 mt-6">
                        <h3 className="text-xl font-bold text-gray-800 mb-3">Refine / Give Feedback</h3>
                        <p className="text-sm text-gray-600 mb-3">Provide specific feedback to adjust meals without generating a whole new plan.</p>
                        <textarea
                            rows="3"
                            value={mealFeedback}
                            onChange={(e) => setMealFeedback(e.target.value)}
                            placeholder="e.g., 'Change Monday's dinner to 200g lean beef with 150g sweet potato.' or 'I dislike the snack on Wednesday, replace it with a high-protein option.'"
                            className="w-full p-2 border border-gray-300 rounded-md focus:ring-red-500 focus:border-red-500 resize-none text-sm mb-4"
                        />
                        <button
                            onClick={handleMealRefinement}
                            disabled={isNutritionLoading || !isAuthReady || !mealFeedback.trim()}
                            className={`w-full py-2 px-6 rounded-lg shadow-lg text-base font-bold text-white transition duration-150 ease-in-out ${isNutritionLoading || !isAuthReady || !mealFeedback.trim() ? 'bg-gray-400 disabled:shadow-none' : 'bg-red-700 hover:bg-red-800 focus:ring-4 focus:ring-red-500'}`}
                        >
                            {isNutritionLoading ? 'Refining...' : 'Refine Meal Plan'}
                        </button>
                    </div>
                )}
            </div>
        );

        // --- COMPLIANCE CALENDAR VIEW ---
        const ComplianceCalendar = () => {
            const [currentMonth, setCurrentMonth] = useState(new Date());

            const getDaysInMonth = (date) => {
                const year = date.getFullYear();
                const month = date.getMonth();
                const firstDayOfMonth = new Date(year, month, 1);
                const lastDayOfMonth = new Date(year, month + 1, 0);
                
                // Get the day index (0=Sun, 6=Sat) for the first day of the month
                const startingDay = firstDayOfMonth.getDay(); 
                
                const totalDays = lastDayOfMonth.getDate();
                const calendarDays = [];

                // Add leading empty days
                for (let i = 0; i < startingDay; i++) {
                    calendarDays.push({ type: 'empty' });
                }

                // Add actual days
                for (let i = 1; i <= totalDays; i++) {
                    const dayDate = new Date(year, month, i);
                    const dateString = dayDate.toISOString().split('T')[0];
                    
                    const isTraining = !!activityLogs[dateString];
                    const isWellness = !!wellnessLogsMap[dateString];
                    const isNutrition = nutritionCompliance[dateString] === true;
                    const isToday = dateString === new Date().toISOString().split('T')[0];
                    
                    calendarDays.push({
                        type: 'day',
                        date: i,
                        dateString,
                        isToday,
                        isTraining,
                        isWellness,
                        isNutrition,
                    });
                }

                return calendarDays;
            };

            const days = getDaysInMonth(currentMonth);
            const monthName = currentMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

            const changeMonth = (delta) => {
                const newMonth = new Date(currentMonth);
                newMonth.setMonth(currentMonth.getMonth() + delta);
                setCurrentMonth(newMonth);
            };
            
            return (
                <div className="space-y-6 p-6 bg-white rounded-xl border border-gray-200 shadow-md">
                    <h2 className="text-2xl font-bold text-gray-800 flex items-center"><Calendar className="w-6 h-6 mr-2 text-green-600" /> Compliance Calendar</h2>
                    <p className="text-sm text-gray-600 mb-4">View your daily adherence across training, wellness, and nutrition.</p>

                    {/* Month Navigation */}
                    <div className="flex justify-between items-center mb-4">
                        <button onClick={() => changeMonth(-1)} className="p-2 rounded-full hover:bg-gray-200 text-gray-600">
                            <ChevronLeft className="w-5 h-5" />
                        </button>
                        <h3 className="text-xl font-semibold text-gray-800">{monthName}</h3>
                        <button onClick={() => changeMonth(1)} className="p-2 rounded-full hover:bg-gray-200 text-gray-600">
                            <ChevronRight className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Legend */}
                     <div className="flex justify-center space-x-4 text-xs font-medium text-gray-600 mb-4">
                        <div className="flex items-center space-x-1">
                            <div className="w-3 h-3 rounded-full bg-green-500"></div>
                            <span>Training</span>
                        </div>
                        <div className="flex items-center space-x-1">
                            <div className="w-3 h-3 rounded-full bg-cyan-500"></div>
                            <span>Wellness</span>
                        </div>
                        <div className="flex items-center space-x-1">
                            <div className="w-3 h-3 rounded-full bg-red-600"></div>
                            <span>Nutrition</span>
                        </div>
                    </div>


                    {/* Day Names */}
                    <div className="grid grid-cols-7 gap-1 border-b border-gray-300 pb-2">
                        {dayNames.map(day => (
                            <div key={day} className="text-center text-sm font-medium text-gray-600">
                                {day}
                            </div>
                        ))}
                    </div>

                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-1">
                        {days.map((day, index) => (
                            <div 
                                key={index} 
                                className={`aspect-square p-1 rounded-lg flex flex-col items-center justify-center relative transition-colors duration-100 ${day.isToday ? 'bg-green-100 border-2 border-green-500' : day.type === 'day' ? 'bg-gray-50 hover:bg-gray-100 border border-transparent' : 'border border-transparent'}`}
                            >
                                <span className={`text-sm font-semibold ${day.isToday ? 'text-green-800' : 'text-gray-700'}`}>
                                    {day.date}
                                </span>
                                
                                {day.type === 'day' && (
                                    <div className="absolute bottom-1 flex space-x-[2px]">
                                        {day.isTraining && (
                                            <div title="Training Logged" className="w-2 h-2 rounded-full bg-green-500 shadow-md"></div>
                                        )}
                                        {day.isWellness && (
                                            <div title="Wellness Logged" className="w-2 h-2 rounded-full bg-cyan-500 shadow-md"></div>
                                        )}
                                        {day.isNutrition && (
                                            <div title="Nutrition Compliant" className="w-2 h-2 rounded-full bg-red-600 shadow-md"></div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            );
        };


        // --- 7. MAIN APP RENDERER ---
        
        if (!isAuthReady) {
            return (
                 <div className="flex items-center justify-center min-h-screen bg-gray-100">
                    <div className="text-center p-6 bg-white rounded-xl shadow-lg">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500 mx-auto mb-4"></div>
                        <p className="text-lg font-semibold text-gray-700">Connecting to ADFIT Database...</p>
                        <p className="text-sm text-gray-500 mt-1">Please wait for authentication to complete.</p>
                    </div>
                </div>
            );
        }
        
        return (
            <div className="min-h-screen bg-gray-100 font-sans text-gray-800">
                {/* Header / Nav */}
                <header className="bg-white shadow-md sticky top-0 z-10">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
                        <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
                            ADFIT
                        </h1>
                        <div className="text-sm text-gray-500 flex items-center space-x-4">
                            <span className="truncate">User ID: {userId.substring(0, 8)}...</span>
                            <button 
                                onClick={handleSignOut} 
                                className="text-red-500 hover:text-red-700 transition duration-150 text-sm font-medium"
                            >
                                Sign Out
                            </button>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <nav className="border-t border-gray-200">
                        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                            <div className="flex space-x-1 sm:space-x-4">
                                {['training', 'wellness', 'nutrition', 'compliance'].map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`py-3 px-3 sm:px-4 text-sm font-medium transition-colors duration-150 flex items-center
                                            ${activeTab === tab 
                                                ? 'text-green-600 border-b-2 border-green-600' 
                                                : 'text-gray-500 hover:text-gray-700 hover:border-b-2 hover:border-gray-300'
                                            }`}
                                    >
                                        {tab === 'training' && <BarChart2 className="w-5 h-5 mr-2" />}
                                        {tab === 'wellness' && <Heart className="w-5 h-5 mr-2" />}
                                        {tab === 'nutrition' && <Utensils className="w-5 h-5 mr-2" />}
                                        {tab === 'compliance' && <Calendar className="w-5 h-5 mr-2" />}
                                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </nav>
                </header>
                
                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                    {error && (
                        <div className="bg-red-100 border border-red-500 text-red-700 px-4 py-3 rounded-xl relative mb-6" role="alert">
                            <strong className="font-bold">Error:</strong>
                            <span className="block sm:inline ml-2">{error}</span>
                            <button onClick={() => setError(null)} className="absolute top-0 bottom-0 right-0 px-4 py-3">
                                 <XCircle className="w-5 h-5 fill-current" />
                            </button>
                        </div>
                    )}
                    
                    {/* --- RENDER CURRENT TAB --- */}
                    {activeTab === 'training' && (
                        <div className="space-y-8">
                            {/* 1. Configuration & Generation */}
                            <div className="p-6 bg-white rounded-xl border border-gray-200 shadow-md">
                                <h2 className="text-2xl font-bold text-gray-800 mb-4">1. Training Program Configuration</h2>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                                    <div>
                                        <label htmlFor="sessions-per-week" className="block text-sm font-medium text-gray-700 mb-1">Sessions / Week (1-7)</label>
                                        <input
                                            type="number" id="sessions-per-week" min="1" max="7" 
                                            value={sessionsPerWeek}
                                            onChange={(e) => setSessionsPerWeek(Number(e.target.value))}
                                            className="w-full p-2 border border-gray-300 rounded-lg text-lg focus:ring-green-500 focus:border-green-500"
                                        />
                                    </div>
                                    <div className="md:col-span-2">
                                        <label htmlFor="training-focus" className="block text-sm font-medium text-gray-700 mb-1">Training Focus and Program Details</label>
                                        <textarea
                                            id="training-focus" rows="2"
                                            value={focusAreas}
                                            onChange={(e) => setFocusAreas(e.target.value)}
                                            placeholder="e.g., Focus on upper body strength 3x, running 2x. Ensure good warm-ups."
                                            className="w-full p-2 border border-gray-300 rounded-lg resize-none text-sm focus:ring-green-500 focus:border-green-500"
                                        />
                                    </div>
                                </div>
                                
                                <button
                                    onClick={handleGenerateWorkout}
                                    disabled={isLoading || !isAuthReady || sessionsPerWeek < 1 || sessionsPerWeek > 7 || !focusAreas.trim()}
                                    className={`w-full flex justify-center items-center py-3 px-6 rounded-lg shadow-lg text-lg font-bold text-white transition duration-150 ease-in-out ${isLoading || !isAuthReady || sessionsPerWeek < 1 || sessionsPerWeek > 7 || !focusAreas.trim() ? 'bg-gray-400 disabled:shadow-none' : 'bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-4 focus:ring-green-500 focus:ring-opacity-70'}`}
                                >
                                    {isLoading ? (
                                        <>
                                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                                            Generating Program...
                                        </>
                                    ) : (
                                        "Generate New 2-Week Adaptive Program"
                                    )}
                                </button>
                            </div>

                            {/* 2. Program Output */}
                            <div className="pt-6 border-t border-gray-200">
                                <h2 className="text-2xl font-bold text-gray-800 mb-4">2. Current Program & Tracker</h2>
                                <div id="program-output" className="bg-gray-50 p-6 rounded-xl border border-gray-200 min-h-[100px]">
                                    {!program && !isLoading && (
                                        <p className="text-gray-500 italic">Configure your sessions and focus areas above to generate your first adaptive 14-day training program.</p>
                                    )}
                                    {program && <ProgramView program={program} activityLogs={activityLogs} />}
                                </div>
                            </div>

                            {/* 3. Program Refinement/Feedback Section */}
                            {program && (
                                <div className="pt-6 border-t border-gray-200 mt-6">
                                    <h3 className="text-xl font-bold text-gray-800 mb-3">Refine / Give Feedback</h3>
                                    <p className="text-sm text-gray-600 mb-3">Provide specific feedback (e.g., "Change Monday's run to sprints") to subtly adjust the program.</p>
                                    <textarea
                                        rows="3"
                                        value={programFeedback}
                                        onChange={(e) => setProgramFeedback(e.target.value)}
                                        placeholder="e.g., The bench press volume is too high on Tuesday; lower sets to 3. I want to replace deadlifts with RDLs on Thursday."
                                        className="w-full p-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 resize-none text-sm mb-4"
                                    />
                                    <button
                                        onClick={handleProgramRefinement}
                                        disabled={isLoading || !isAuthReady || !programFeedback.trim()}
                                        className={`w-full py-2 px-6 rounded-lg shadow-lg text-base font-bold text-white transition duration-150 ease-in-out ${isLoading || !isAuthReady || !programFeedback.trim() ? 'bg-gray-400 disabled:shadow-none' : 'bg-green-700 hover:bg-green-800 focus:ring-4 focus:ring-green-500'}`}
                                    >
                                        {isLoading ? 'Refining...' : 'Refine Program'}
                                    </button>
                                </div>
                            )}
                            
                            {/* 4. History */}
                            <div className="pt-6 border-t border-gray-200">
                                <h2 className="text-2xl font-bold text-gray-800 mb-4">3. Program History</h2>
                                <HistoryList history={history} />
                            </div>
                            
                            /* Daily Log Modal */
                            {showLogModal && <DailyLogModal 
                                dayData={currentDayToLog}
                                onClose={() => setShowLogModal(false)}
                                isLoading={isLoading}
                            />}
                        </div>
                    )}
                    
                    {activeTab === 'wellness' && <WellnessTracker />}
                    {activeTab === 'nutrition' && <NutritionTracker />}
                    {activeTab === 'compliance' && <ComplianceCalendar />}
                </main>
            </div>
        );
    };

    export default App;
