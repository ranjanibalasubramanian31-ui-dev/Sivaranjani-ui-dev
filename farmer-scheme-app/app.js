/* Farmer Scheme Eligibility Agent — front-end logic
   Loads the schemes JSON (local for now; later from S3 / Bedrock agent),
   runs a deterministic local pre-filter + scoring, and (optionally)
   forwards the profile to a Bedrock agent endpoint when configured.
*/

const { createApp, reactive, computed, ref, onMounted } = Vue;

// ----- CONFIG ------------------------------------------------------------
// To call your Bedrock agent, expose an HTTPS endpoint (API Gateway -> Lambda
// -> bedrock-agent-runtime InvokeAgent) and set the URL below. When empty,
// the app falls back to local matching against the JSON.
const BEDROCK_AGENT_ENDPOINT = ""; // e.g. "https://abc123.execute-api.ap-south-1.amazonaws.com/prod/match"

// Where the schemes JSON lives. Either bundle locally or use a public S3 URL.
const SCHEMES_URL = "./farmer_schemes_complete.json";

// ----- STATIC LOOKUPS ----------------------------------------------------
const STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Delhi","Goa","Gujarat",
  "Haryana","Himachal Pradesh","Jammu & Kashmir","Jharkhand","Karnataka","Kerala","Madhya Pradesh",
  "Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim",
  "Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal"
];

const CAT_ICONS = {
  financial_support: "💰",
  farming_infrastructure: "🏗",
  agriculture_crop_development: "🌱",
  allied_farming_activities: "🐄",
  training_market_support: "📊",
  special_farmer_categories: "⭐",
};
const CAT_SUBTITLES = {
  financial_support: "Loans, subsidies & insurance",
  farming_infrastructure: "Facilities & productivity",
  agriculture_crop_development: "Cultivation & crop improvement",
  allied_farming_activities: "Animal farming sectors",
  training_market_support: "Learn & sell better",
  special_farmer_categories: "Targeted support groups",
};

// ----- SCORING -----------------------------------------------------------
function farmerType(acres) {
  if (acres == null || isNaN(acres)) return "small";
  if (acres <= 2) return "marginal";
  if (acres <= 5) return "small";
  return "large";
}

function scoreScheme(scheme, profile) {
  const e = scheme.eligibility || {};
  let score = 50;
  const reasons = [];

  // Age
  if (e.age_min != null && profile.age < e.age_min) return null;
  if (e.age_max != null && profile.age > e.age_max) return null;

  // Land
  if (e.land_size_min_acres != null && profile.land < e.land_size_min_acres) return null;
  if (e.land_size_max_acres != null && profile.land > e.land_size_max_acres) return null;

  // Gender
  if (e.gender && e.gender !== "all" && e.gender.toLowerCase() !== (profile.gender||"").toLowerCase()) return null;

  // States
  if (Array.isArray(e.states)) {
    if (!e.states.includes(profile.state)) return null;
    score += 15; reasons.push(`available in ${profile.state}`);
  } else if (e.states === "all") {
    score += 5;
  }

  // Social category
  if (Array.isArray(e.social_category) && profile.social && !e.social_category.includes(profile.social)) return null;
  if (Array.isArray(e.social_category) && (profile.social==="SC"||profile.social==="ST")) {
    score += 10; reasons.push(`extra subsidy for ${profile.social} farmers`);
  }

  // Farmer type
  const ft = farmerType(profile.land);
  if (Array.isArray(e.farmer_type)) {
    if (!e.farmer_type.includes(ft)) return null;
    score += 10; reasons.push(`open for ${ft} farmers`);
  }

  // Women bonus
  if ((profile.gender||"").toLowerCase()==="female" && /women|mahila|mksp/i.test(scheme.name)) {
    score += 15; reasons.push("women-focused scheme");
  }

  // Cap & jitter for visual variety
  score = Math.min(98, score + Math.floor(Math.random()*8));

  const reason = reasons.length
    ? reasons.join(", ").replace(/^./, c=>c.toUpperCase())
    : "Your profile matches the basic eligibility for this scheme";

  return { scheme, score, reason };
}

// ----- APP ---------------------------------------------------------------
createApp({
  setup() {
    const step = ref(1);
    const data = ref(null);

    const profile = reactive({
      name:"", age:30, gender:"", state:"", land:1, social:""
    });

    const selectedCat = ref("");
    const selectedSubs = ref([]);
    const matched = ref([]);
    const filter = ref("all");

    onMounted(async () => {
      try {
        const r = await fetch(SCHEMES_URL);
        data.value = await r.json();
      } catch (e) {
        console.error("Failed to load schemes", e);
        alert("Could not load schemes JSON. Place farmer_schemes_complete.json next to index.html or update SCHEMES_URL.");
      }
    });

    const categories = computed(() => data.value?.categories || []);
    const currentCat = computed(() => categories.value.find(c => c.id === selectedCat.value));
    const currentCatName = computed(() => currentCat.value?.name || "");
    const subList = computed(() => currentCat.value?.sub_categories || []);

    const canNext1 = computed(() =>
      profile.name && profile.age && profile.gender && profile.state && profile.land != null && profile.social
    );

    function toggleSub(id) {
      const i = selectedSubs.value.indexOf(id);
      if (i === -1) selectedSubs.value.push(id);
      else selectedSubs.value.splice(i,1);
    }

    async function runMatch() {
      // Try Bedrock-agent endpoint first (if configured)
      if (BEDROCK_AGENT_ENDPOINT) {
        try {
          const r = await fetch(BEDROCK_AGENT_ENDPOINT, {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({
              profile,
              category: selectedCat.value,
              sub_categories: selectedSubs.value,
            }),
          });
          if (r.ok) {
            const out = await r.json();
            // Expecting [{scheme, score, reason}] or {matches:[...]}
            matched.value = out.matches || out;
            step.value = 4;
            return;
          }
        } catch (e) { console.warn("Bedrock call failed, falling back", e); }
      }

      // Local fallback: pre-filter by chosen sub-categories then score
      const subs = subList.value.filter(s => selectedSubs.value.includes(s.id));
      const allSchemes = subs.flatMap(s => s.schemes || []);
      matched.value = allSchemes
        .map(s => scoreScheme(s, profile))
        .filter(Boolean)
        .sort((a,b) => b.score - a.score)
        .slice(0, 12);
      step.value = 4;
    }

    const filtered = computed(() => {
      if (filter.value === "all") return matched.value;
      if (filter.value === "central") return matched.value.filter(m => m.scheme.type === "central");
      if (filter.value === "state")   return matched.value.filter(m => m.scheme.type === "state");
      if (filter.value === "women")   return matched.value.filter(m =>
        /women|mahila|mksp/i.test(m.scheme.name) ||
        (m.scheme.eligibility && m.scheme.eligibility.gender === "female"));
      return matched.value;
    });

    function restart() {
      step.value = 1; selectedCat.value = ""; selectedSubs.value = []; matched.value = []; filter.value = "all";
    }

    return {
      step, profile, states: STATES,
      categories, catIcons: CAT_ICONS, catSubtitles: CAT_SUBTITLES,
      selectedCat, selectedSubs, subList, canNext1, toggleSub,
      runMatch, matched, filtered, filter, currentCatName, restart,
    };
  }
}).mount("#app");
