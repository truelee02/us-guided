'use strict';
/*
 * Space relationship types. A Space's type (stored on spaces.kind) shapes
 * everything the Guide produces for it: mediation tone, the daily focus,
 * the Together-tab ideas, and the weekly connection activity. This module
 * is the single source of truth for the seven types — display names,
 * picker blurbs, Guide framing, per-type focus guidance, and the curated
 * (stub-mode / fallback) content shelves for each type.
 *
 * Legacy values: spaces created before types existed stored 'couple'
 * (now 'partner') or 'family'. db.js migrates 'couple' -> 'partner' at
 * load; normalizeKind() below also maps it anywhere else it surfaces.
 */

const SPACE_TYPES = {
  partner: {
    name: 'Romantic partner',
    blurb: 'For couples — warmth, closeness, and working through things together.',
    icon: '💑',
    group: false,
    framing: 'This is a romantic partners\' shared chat. Be warm and intimacy-friendly: closeness, affection and romance are welcome framings here.',
    focusGuidance: 'Write a focus keyed to the OTHER person\'s love language where known — a concrete, affectionate action they can do today for their partner.',
    together: {
      heading: '🎲 This week\'s date ideas',
      savedHeading: '💡 Saved date ideas',
      dailyHeading: '🌱 Today\'s connection activity',
      categories: ['at home', 'little to no cost', 'no sitter needed', 'out & about'],
    },
  },
  coparent: {
    name: 'Co-parents',
    blurb: 'Raising kids together from two homes — clear, calm coordination.',
    icon: '🧒',
    group: false,
    framing: 'This is a CO-PARENTING chat between two parents raising children from two homes. Be neutral, business-calm and kid-centered at all times. NEVER use romantic framing, affection or intimacy language. Keep everything practical: schedules, handoffs, consistency between homes, and the children\'s wellbeing come first. Help both parents keep the kids out of the middle of adult disagreements.',
    focusGuidance: 'Write ONE short, practical piece of co-parenting advice for today — kid-centered, concrete, and calm. It should help this parent AND help the kids (smooth handoffs, consistency between homes, keeping kids out of the middle, clear brief communication). Never romantic.',
    together: {
      heading: '🗂️ This week\'s coordination ideas',
      savedHeading: '💡 Saved coordination ideas',
      dailyHeading: '🌱 Today\'s co-parenting focus activity',
      categories: ['handoffs', 'one shared plan', 'school & medical', 'kid events'],
    },
  },
  parent_child: {
    name: 'Parent & child',
    blurb: 'A parent and their child — staying close across the years.',
    icon: '👨‍👧',
    group: false,
    framing: 'This is a chat between a parent and their child (of any age). Be warm across the generations: respect flows both ways, and the goal is understanding and time together, not romance.',
    focusGuidance: 'Write a focus that is a connection moment or a conversation nudge — one concrete thing they can do or ask today to feel closer to their parent/child.',
    together: {
      heading: '🎲 Time together this week',
      savedHeading: '💡 Saved time-together ideas',
      dailyHeading: '🌱 Today\'s connection activity',
      categories: ['at home', 'little to no cost', 'out & about', 'from a distance'],
    },
  },
  family: {
    name: 'Family',
    blurb: 'The whole family in one space — connection and coordination.',
    icon: '👨‍👩‍👧',
    group: true,
    framing: 'This is a FAMILY group chat with several members. Address the group as a whole, not as a couple. Facilitate: give each person something specific, and invite members by name to respond.',
    focusGuidance: 'Write a focus that is a group connection or coordination nudge — one concrete thing they can do today for the family.',
    together: {
      heading: '🤲 Things to do together this week',
      savedHeading: '💡 Saved ideas',
      dailyHeading: '🌱 Today\'s connection activity',
      categories: ['at home', 'little to no cost', 'out & about', 'helping each other'],
    },
  },
  friends: {
    name: 'Friends',
    blurb: 'Friends who want to stay close and talk honestly.',
    icon: '🎉',
    group: true,
    framing: 'This is a chat between friends. Keep it light, warm and low-pressure: showing up for each other, making plans, and clearing the air early when something feels off.',
    focusGuidance: 'Write a focus that is a light connection nudge — one small, easy thing they can do today to make a friend feel thought of.',
    together: {
      heading: '🎲 Hangout ideas this week',
      savedHeading: '💡 Saved hangout ideas',
      dailyHeading: '🌱 Today\'s connection activity',
      categories: ['at home', 'little to no cost', 'out & about', 'from a distance'],
    },
  },
  roommates: {
    name: 'Roommates',
    blurb: 'Sharing a home — chores, bills, guests, and keeping the peace.',
    icon: '🏠',
    group: true,
    framing: 'This is a ROOMMATES\' chat about sharing a home. Be practical and fairness-focused: chores, bills, shared spaces, guests and quiet hours. Everything should be concrete, even-handed and logistics-friendly — no romantic or family framing.',
    focusGuidance: 'Write a focus that is a house-peace or fairness action — one concrete thing they can do today that makes the shared home run more fairly or calmly.',
    together: {
      heading: '🏠 House ideas this week',
      savedHeading: '💡 Saved house ideas',
      dailyHeading: '🌱 Today\'s house activity',
      categories: ['shared meals', 'chore fairness', 'house projects', 'house peace'],
    },
  },
  caregivers: {
    name: 'Caregivers',
    blurb: 'Family coordinating care for a loved one — no one carries it alone.',
    icon: '💛',
    group: true,
    framing: 'This is a chat for family members coordinating care for a loved one (a parent, relative or friend who needs support). Be supportive and coordination-focused: clear plans, shared load, respite for whoever is carrying the most, and calm decision-making. Acknowledge the emotional weight without being clinical.',
    focusGuidance: 'Write a focus that is a coordination or respite nudge — one concrete thing they can do today to share the care load more fairly or give someone (including themselves) a breather.',
    together: {
      heading: '🗂️ Care-coordination ideas this week',
      savedHeading: '💡 Saved care ideas',
      dailyHeading: '🌱 Today\'s care activity',
      categories: ['visit & appointment planning', 'respite swaps', 'family check-ins', 'sharing the load'],
    },
  },
};

const TYPE_KEYS = Object.keys(SPACE_TYPES);
const LEGACY_KIND_MAP = { couple: 'partner' };

function normalizeKind(kind) {
  if (kind && SPACE_TYPES[kind]) return kind;
  if (kind && LEGACY_KIND_MAP[kind]) return LEGACY_KIND_MAP[kind];
  return 'partner';
}
function isValidKind(kind) {
  return !!(kind && SPACE_TYPES[kind]);
}
function typeMeta(kind) {
  return SPACE_TYPES[normalizeKind(kind)];
}
function kindName(kind) {
  return typeMeta(kind).name;
}

module.exports = { SPACE_TYPES, TYPE_KEYS, LEGACY_KIND_MAP, normalizeKind, isValidKind, typeMeta, kindName };
