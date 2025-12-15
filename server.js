// (moved) /ai/choreo-generator route is defined later, after app initialization.
// Cleanup placeholders
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const multer = require('multer');
const app = express();
const upload = multer();

const PORT = process.env.PORT || 3000;
const KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL || '';
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 780000); // ~13 min (< Render free 15m sleep)

// Log all incoming requests for debugging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
// Robust helper to call Groq API or fallback to demo
async function tryGroq(system, prompt, opts = {}) {
    const {
        temperature = 0.7,
        max_tokens = 256,
        fallback = null,
        model: overrideModel = null,
        models: overrideModels = null
    } = opts;
    const apiKey = process.env.GROQ_API_KEY;
    const envModels = (process.env.GROQ_MODELS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const fallbackModels = [
        overrideModel || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        'llama-3.3-8b-instant',
        'llama-3.2-90b-text-preview',
        'llama-3.2-11b-text-preview'
    ];
    const defaultModels = (overrideModels || envModels || [])
        .concat(fallbackModels)
        .filter(Boolean)
        // Deduplicate while preserving order
        .filter((m, idx, arr) => arr.indexOf(m) === idx);
    // If no API key, fallback immediately
    if (!apiKey) {
        if (typeof fallback === 'function') {
            return { success: false, content: fallback() };
        }
        return { success: false, content: null, error: 'GROQ_API_KEY not set' };
    }
    for (const model of defaultModels) {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        ...(system ? [{ role: 'system', content: system }] : []),
                        { role: 'user', content: prompt },
                    ],
                    temperature,
                    max_tokens,
                }),
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Groq API error: ${response.status} ${errText}`);
            }
            const data = await response.json();
            const text = data.choices?.[0]?.message?.content?.trim();
            if (!text) {
                if (typeof fallback === 'function') {
                    return { success: false, content: fallback() };
                }
                return { success: false, content: null, error: 'No content from Groq' };
            }
            return { success: true, content: text, model };
        } catch (err) {
            console.error('tryGroq error (model', model, '):', err?.message || err);
            // continue to next model
        }
    }
    if (typeof fallback === 'function') {
        return { success: false, content: fallback() };
    }
    return { success: false, content: null, error: 'All Groq models failed' };
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves the frontend
// Lightweight health check endpoint for uptime monitors and cold-start pings
app.get('/health', (req, res) => {
    res.type('text/plain').send('OK');
});

// Mock data for demo mode
const mockSuggestions = {
    'Tihai': [
        'Dha Dhin Dhin Dha | Dha Jha Nu | Dha Dhin Dhin Dha | Dha Jha Nu | Dha Dhin Dhin Dha Dha',
        'Ta Ki Ta | Dha Dhin Dhin | Ta Ki Ta | Dha Dhin Dhin | Ta Ki Ta Dha',
        'Dha Dhin Dhun | Na Kat Dha | Dha Dhin Dhun | Na Kat Dha | Dha Dhin Dhun Dha',
    ],
    'Toda': [
        'Dha Dhin Dhin Dha Ta Ki Ta | Dha Jha Nu Dha | Dha Dhin Dhin Dha Ta Ki Ta Ta',
        'Ta Dhin Dhin Ta | Ta Dhin Dhin Ta | Ta Dhin Dhin Ta | Dhum Tah',
        'Dha Ki Ta | Jha Nu Dha | Dha Ki Ta | Jha Nu Dha | Dha Ki Ta Dha Dhum',
    ],
    'Chakkar': [
        'Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dhum',
        'Ta Ki Ta Jha | Nu Dha | Ta Ki Ta Jha | Nu Dha | Ta Ki Ta',
        'Dha Dhin | Ta Jha Nu | Dha Dhin | Ta Jha Nu | Dha Dhin Dha',
    ],
    'Aamad': [
        'Dha Dhin Dhin Dha | Ta Ki Ta | Dha Jha Nu Dha',
        'Ta Dhin Dhin Ta | Na Kat Dha | Ta Dhin Dhin Ta',
        'Dha Dhin Dha | Dha Dhin Dha | Dha Dhin Dha | Dhum Tah',
    ]
};


// 0) AI Route with fallback and demo mode
app.post('/generate-step', async (req, res) => {
    const { taal, type, context } = req.body;
    console.log(`She asked for: ${type} in ${taal}`);

    // System prompt for AI
    const systemPrompt = `You are an expert Kathak Choreographer.
    Generate a creative, rhythmic '${type}' sequence for '${taal}'.
    
    Rules:
    1. Output ONLY the Bols (syllables). No explanations.
    2. Use standard syllables like: Dha, Dhin, Ta, Na, TiTa, KiTa, Tak, Dhum.
    3. Make sure it fits the rhythm structure of ${taal}.
    4. If she provided context: "${context}", try to match that flow.`;

    // Use tryGroq (mixtral) with fallback to demo
    const ai = await tryGroq(systemPrompt, `Generate a ${type}`, { temperature: 0.7 });
    if (ai.success) {
        return res.json({ result: ai.content });
    }

    // If AI fails, use demo mode with mock data
    console.log('AI failed, using demo mode with mock suggestions');
    const suggestions = mockSuggestions[type] || mockSuggestions['Tihai'];
    const randomSuggestion = suggestions[Math.floor(Math.random() * suggestions.length)];
    return res.json({ 
        result: randomSuggestion,
        demo: true,
        message: '(Using demo mode - connect to internet or update API for live AI suggestions)'
    });
});

// New AI endpoints: bol explanation, variations, practice plan

// 1) Explain a single bol or short phrase
app.post('/ai/bol-explain', async (req, res) => {
    const { bol } = req.body;
    if (!bol) return res.status(400).json({ error: 'Missing bol in request' });

    const systemPrompt = `You are a helpful Kathak teacher. Provide a short (1-2 sentence) explanation of the given bol or short bol phrase. Keep it simple, actionable, and aimed at a beginner-to-intermediate student. Output ONLY the explanation, no examples.`;
    const userPrompt = `Explain this bol/phrase: "${bol}"`;

    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.5 });
    if (tryResult.success) {
        return res.json({ result: tryResult.content });
    }

    // Fallback small dictionary
    const fallback = {
        'Dha': 'A strong bass stroke played on the lower part of the tabla/kartal, often the anchor of a phrase.',
        'Dhin': 'A resonant stroke combining bass and treble; used frequently in Tāla patterns.',
        'Ta': 'A crisp treble stroke emphasizing lighter sound.',
        'Na': 'A sharp treble stroke, often used in quicker patterns.',
        'KiTa': 'A combined small phrase with quick articulation.',
        'Tak': 'A short, sharp stroke used for rhythm accents.',
        'Dhum': 'A louder bass-heavy stroke used for emphasis.'
    };

    const explanation = fallback[bol] || `A rhythmic syllable used in Kathak; listen and match the sound and weight to the music.`;
    res.json({ result: explanation, demo: true });
});

// 2) Generate simple variations for a bol sequence
app.post('/ai/variations', async (req, res) => {
    const { bols, count = 3 } = req.body;
    if (!bols) return res.status(400).json({ error: 'Missing bols in request' });

    const systemPrompt = `You are an expert Kathak choreographer. Given a short sequence of bols, produce ${count} creative variations that preserve rhythmic feel. Output a JSON array of strings and nothing else.`;
    const userPrompt = `Bols: "${bols}"\nReturn ${count} variations as a JSON array.`;

    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.8 });
    if (tryResult.success) {
        // Try to parse JSON if model returned an array
        try {
            const parsed = JSON.parse(tryResult.content);
            return res.json({ results: parsed });
        } catch (e) {
            // If not JSON, split by newlines
            const parts = tryResult.content.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
            return res.json({ results: parts });
        }
    }

    // Fallback simple algorithm: rotate and substitute
    const toks = bols.split(/\s+/).filter(Boolean);
    const subs = { 'Dha': 'Ta', 'Dhin': 'Na', 'Ta': 'Dha', 'Na': 'Dhin' };
    const results = [];
    for (let i=0;i<count;i++) {
        const r = toks.map((t, idx) => (idx % 2 === i % 2 ? (subs[t] || t) : t)).join(' ');
        results.push(r);
    }
    res.json({ results, demo: true });
});

// 3) Autogenerate a short 7-day practice plan
app.post('/ai/practice-plan', async (req, res) => {
    const { level = 'beginner', minutesPerDay = 30, days = 7 } = req.body;

    const systemPrompt = `You are a patient Kathak instructor. Create a ${days}-day practice plan for a ${level} student with ${minutesPerDay} minutes per day. Output a JSON object where keys are day numbers (1..${days}) and values are short practice tasks. Do not include extra commentary.`;
    const userPrompt = `Generate the plan now.`;

    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.6 });
    if (tryResult.success) {
        // Prefer: extract the first complete JSON array of objects and parse
        const extractBalancedArray = (text) => {
            const start = text.indexOf('[');
            if (start === -1) return null;
            let depth = 0;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (ch === '[') depth++;
                else if (ch === ']') {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.slice(start, i + 1);
                        try {
                            const parsed = JSON.parse(candidate);
                            if (Array.isArray(parsed)) return parsed;
                        } catch {}
                        break;
                    }
                }
            }
            return null;
        };
        const balancedArr = extractBalancedArray(tryResult.content);
        if (balancedArr) {
            const normalized = balancedArr
                .filter(s => s && (s.section || s.bol || s.movement))
                .map((s, i) => ({
                    section: s.section || `Section ${i + 1}`,
                    bol: s.bol || s.movement || 'Bols unavailable',
                    movement: s.movement || s.bol || 'Movement unavailable',
                    commentary: s.commentary
                }))
                .slice(0, stepsCount);
            if (normalized.length) {
                return res.json({ choreography: normalized, ai: true });
            }
        }
        try {
            const parsed = JSON.parse(tryResult.content);
            return res.json({ plan: parsed });
        } catch (e) {
            // If not JSON, return as text
            return res.json({ planText: tryResult.content });
        }
    }

    // Fallback simple plan
    const fallbackPlan = {};
    for (let i=1;i<=days;i++) {
        fallbackPlan[i] = `Day ${i}: Warm-up (5 min), bols practice (15 min), choreography review (${Math.max(5, minutesPerDay-20)} min)`;
    }
    res.json({ plan: fallbackPlan, demo: true });
});


// 4) AI Pose Suggestion endpoint
app.post('/ai/pose-suggestion', async (req, res) => {
    const { taal = '', level = '', theme = '' } = req.body;
    const context = [taal, level, theme].filter(Boolean).join(', ');
    const systemPrompt = `You are a creative and expert Kathak dance teacher. Given a context (such as a mood, theme, or choreography section), suggest a single pose or gesture that fits well. Describe the pose in 1-2 sentences, focusing on body position, hand mudra, and facial expression. Output only the suggestion.`;
    const userPrompt = context ? `Suggest a Kathak pose for: ${context}` : 'Suggest a creative Kathak pose.';

    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.8 });
    if (tryResult.success) {
        return res.json({ poses: tryResult.content });
    }

    const fallbackPoses = [
        'Stand in Samapada (feet together), right hand in Pataka mudra raised to shoulder height, left hand on waist, gentle smile.',
        'Left foot forward, torso slightly turned, both hands in Alapadma mudra at chest level, eyes looking to the left.',
        'Right knee bent, left leg extended back, right hand in Tripataka mudra above head, left hand extended sideways, serene expression.',
        'Both arms raised in a circular arc, fingers in Hamsasya mudra, chin lifted, soft gaze upward.',
        'Standing on left foot, right foot in kunchita (flexed), both hands in Katakamukha mudra at heart center, playful smile.'
    ];
    const randomPose = fallbackPoses[Math.floor(Math.random() * fallbackPoses.length)];
    res.json({ poses: randomPose, demo: true });
});

// 5) Generate a full Kathak choreography sequence (STRICT JSON-ONLY MODE)
app.post('/ai/choreo-generator', async (req, res) => {
    const { taal = 'Teentaal', theme = 'joy', level = 'intermediate', length = 5 } = req.body;
    const stepsCount = Number(length) || 5;
    
    // Enhanced system prompt: ULTRA-STRICT to prevent any extra text
    const systemPrompt = `You are a master Kathak choreographer. Generate ONLY a valid JSON array with exactly ${stepsCount} choreography steps.
    
CRITICAL RULES:
1. Output ONLY the JSON array. NO other text before, after, or between steps.
2. Do NOT include "Bol:", "Movement:", "Section:", explanations, or markdown.
3. Do NOT output multiple arrays or repeating sections.
4. Each step MUST be a valid JSON object with these fields (exactly):
   {
     "section": "string (e.g. Introduction, Krishna's Dance, Finale)",
     "bol": "string (e.g. Dha Ge Na, Na Dha Ni Dha)",
     "movement": "string (descriptive movement in 1-2 sentences)",
     "commentary": "string (optional, empty string if not provided)"
   }
5. No additional fields. No nested arrays.
6. Ensure all quotes are double quotes. Escape special characters.
7. Return exactly ${stepsCount} valid steps inside [ ... ].
8. If you cannot generate valid JSON, return an empty array: []

Example output format:
[
  {"section":"Section Name","bol":"Dha Dhin","movement":"Move description","commentary":"Optional note"},
  {"section":"Next Section","bol":"Na Dha","movement":"Next move","commentary":""}
]`;
    
    const userPrompt = `Generate exactly ${stepsCount} choreography steps for a ${level} dancer in ${taal}, themed around "${theme}". Return ONLY the JSON array with no other text.`;

    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.6, max_tokens: 1024 });
    
    // ULTRA-STRICT: Extract ONLY the first complete JSON array, discard everything else
    const extractFirstArray = (text) => {
        const bracketStart = text.indexOf('[');
        if (bracketStart === -1) return null;
        let depth = 0, arrayEnd = -1;
        for (let i = bracketStart; i < text.length; i++) {
            if (text[i] === '[') depth++;
            else if (text[i] === ']') {
                depth--;
                if (depth === 0) {
                    arrayEnd = i;
                    break;
                }
            }
        }
        if (arrayEnd === -1) return null;
        try {
            const substring = text.slice(bracketStart, arrayEnd + 1);
            return JSON.parse(substring);
        } catch (parseErr) {
            console.error('Parse error:', parseErr.message);
            return null;
        }
    };
    
    if (tryResult.success) {
        const balancedArr = extractFirstArray(tryResult.content);
        if (balancedArr && Array.isArray(balancedArr)) {
            // STRICT VALIDATION: each step MUST have section, bol, AND movement
            const normalized = balancedArr
                .filter(s => s && s.section && s.bol && s.movement && typeof s.section === 'string' && typeof s.bol === 'string' && typeof s.movement === 'string')
                .map((s, i) => ({
                    section: s.section.trim(),
                    bol: s.bol.trim(),
                    movement: s.movement.trim(),
                    commentary: (s.commentary && typeof s.commentary === 'string') ? s.commentary.trim() : ''
                }))
                .slice(0, stepsCount);
            if (normalized.length) {
                console.log(`[Choreo Generator] Generated ${normalized.length} valid steps from AI`);
                return res.json({ choreography: normalized, ai: true, model: tryResult.model });
            }
        }
        
        // If parsing failed, return clear error (never raw text)
        console.error('[Choreo Generator] Failed to parse AI response as valid JSON array');
        return res.status(400).json({ 
            choreography: [], 
            ai: true, 
            error: 'AI response was not a valid JSON array. Please regenerate.' 
        });
    }
    
    // AI API call failed entirely
    console.error('[Choreo Generator] Groq API call failed:', tryResult.error);
    return res.status(502).json({ 
        choreography: [], 
        error: tryResult.error || 'AI service unavailable. Check GROQ_API_KEY and internet connection.' 
    });
});

// 6) Simple reminders endpoint (placeholder)
app.post('/ai/reminder', async (req, res) => {
    const { text = 'Practice today', when = 'tomorrow' } = req.body || {};
    const systemPrompt = `You are a helpful assistant for a Kathak student. Create a concise reminder sentence. Output only the sentence.`;
    const userPrompt = `Reminder: ${text}. Time: ${when}.`;
    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.4 });
    const message = tryResult.success ? tryResult.content : `Reminder: ${text} — ${when}.`;
    res.json({ reminder: message, when });
});

// 7) Gesture/Mudra dictionary endpoint
app.post('/ai/gesture-dictionary', async (req, res) => {
    const { gesture = req.body?.gestureName || 'Pataka' } = req.body || {};
    const systemPrompt = `You are a Kathak expert. Provide a brief (2-3 sentences) explanation of the hand gesture (mudra) or body movement term. Focus on technique and meaning.`;
    const userPrompt = `Explain the Kathak gesture: ${gesture}`;
    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.5 });
    const gestures = {
        'Pataka': 'Hand straight with fingers together, palm facing down. Represents opening, spreading, or introducing motion.',
        'Tripataka': 'Three fingers extended (index, middle, ring), thumb and pinky folded. Used for pointing, indicating, or specific movements.',
        'Ardhapataka': 'Four fingers extended, thumb folded. Represents holding or grasping.',
        'Katakamukha': 'Fingers curved like a beak. Used for delicate, precise movements and expressions.'
    };
    const explanation = tryResult.success ? tryResult.content : (gestures[gesture] || `A traditional Kathak gesture representing movement and expression.`);
    // Frontend expects j.gesture; send explanation there.
    res.json({ gesture: explanation, term: gesture, explanation });
});

// 8) Mood-based practice generator
app.post('/ai/mood-practice', async (req, res) => {
    const { mood = 'joyful', time = 30, goals = '' } = req.body || {};
    const duration = Number(time) || 30;
    const systemPrompt = `You are a Kathak instructor designing a ${duration}-minute practice session for a ${mood} mood. Include goals: ${goals}. Output a JSON with 'warmup', 'main', and 'cooldown' sections, each as a string.`;
    const userPrompt = `Create a ${duration}-minute ${mood} Kathak practice session. Goals: ${goals}`;
    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.75 });
    const fallbackPlan = {
        warmup: 'Gentle footwork patterns (tatkaar) at slow tempo for 5 minutes.',
        main: 'Bol exercises and creative choreography matching the mood for 20 minutes.',
        cooldown: 'Breathing and stretching exercises for 5 minutes.'
    };
    if (tryResult.success) {
        try {
            const parsed = JSON.parse(tryResult.content);
            // Build a readable planText for frontend
            const planText = Object.entries(parsed).map(([k,v]) => `${k}: ${v}`).join('\n');
            return res.json({ mood, duration, plan: parsed, planText });
        } catch (e) {
            const planText = Object.entries(fallbackPlan).map(([k,v]) => `${k}: ${v}`).join('\n');
            return res.json({ mood, duration, plan: fallbackPlan, planText });
        }
    }
    const planText = Object.entries(fallbackPlan).map(([k,v]) => `${k}: ${v}`).join('\n');
    res.json({ mood, duration, plan: fallbackPlan, planText, demo: true });
});

// 9) Feedback and correction endpoint
app.post('/ai/feedback', upload.none(), async (req, res) => {
    const { notes = '', performance = '', aspect = 'technique', taal = '', level = '' } = req.body || {};
    const detail = performance || notes || 'My footwork felt uneven';
    const focus = aspect || (level || 'technique');
    const systemPrompt = `You are an experienced Kathak teacher. Provide constructive, encouraging feedback (2-3 sentences) on the student's ${focus} aspect. If details are given, reference them. Be specific to the provided taal and level.`;
    const userPrompt = `Student notes: "${detail}". Taal: ${taal || 'unspecified'}. Level: ${level || 'unspecified'}. Focus: ${focus}.`;
    const tryResult = await tryGroq(systemPrompt, userPrompt, { temperature: 0.6 });
    const fallbackFeedback = `Keep rhythm steady in ${taal || 'the taal'}. Focus on ${focus}; practice slow counts, then add speed. Maintain lifted posture and clear foot articulation.`;
    const feedback = tryResult.success ? tryResult.content : fallbackFeedback;
    res.json({ feedback, aspect: focus });
});

// Catch-all for unknown API endpoints to avoid sending HTML to frontend expecting JSON

app.use('/ai', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Natya-Note is ready at http://localhost:${PORT}`);

    // Keep-alive pings to reduce cold starts on free hosts (Render, etc.)
    if (KEEPALIVE_URL) {
        const target = `${KEEPALIVE_URL.replace(/\/$/, '')}/health`;
        console.log(`Keep-alive enabled: pinging ${target} every ${Math.round(KEEPALIVE_INTERVAL_MS/60000)} min`);
        setInterval(() => {
            fetch(target).catch(err => console.warn('Keep-alive ping failed:', err.message));
        }, KEEPALIVE_INTERVAL_MS);
    }
});