// sections.js
// Central place to edit the copy, model path, and per-section overrides.
// Add or remove entries in the `sections` array as needed. Each section can
// override text, background text, camera offsets, and visual settings.

export const SECTION_TRANSITION = {
  spinTurns: 1.0,           // number of full rotations per section change
  spinDuration: 2.6,        // seconds for the rotation to complete
  scatterOut: 0.85,         // default scatter peak while swapping models
  scatterPeak: 0.85,        // explicit peak scatter amount
  scatterIn: 0.0,           // resting scatter once the new section settles
  scatterSpeed: 4.5,        // higher = faster scatter easing
  progressEase: 6.0,        // smoothing factor for scroll-linked progress
  fadeDuration: 0.55,       // seconds for text fade in/out
  wheelThreshold: 80,      // scroll delta needed to trigger a section change
  scrollScale: 900,         // how much scroll (deltaY) maps to full transition progress
  progressTween: 0.35,      // seconds for GSAP tween between scroll targets
  progressEaseName: 'power2.out',
  backgroundTween: 0.45,
  backgroundEase: 'power2.out',
};

export const sections = [
  {
    id: 'intro',
    eyebrow: 'Chapter 01',
    title: ['The Cost of', 'a Question'],
    body: 'How do we map the emotional pulse of a city when the data refuses to sit still?',
    modelPath: 'point/akl3-bw.ply',
    backgroundText: ['The Cost of', 'A Question'],
    camera: { pathT: 0.1, yaw: -18, pitch: -8 },
    transform: {
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
      offset: { x: 0, y: 0, z: 0 }
    },
    settings: {
      highlightColor: '#b9e456',
      background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
      useOriginalPointColors: true,
    },
  },
  {
    id: 'harbour',
    eyebrow: 'Chapter 02',
    title: ['Tidal Exchanges', 'of Belonging'],
    body: 'Every commute, every glance, every fragment of conversation leaves a trace that drifts like harbour mist.',
    modelPath: 'point/nz2.ply',
    backgroundText: ['Tidal Exchanges', 'Of Belonging'],
    camera: { pathT: 0.1, yaw: -18, pitch: -6 },
    transform: {
      rotation: { x: 0, y: 0.95, z: 0.05 },
      scale: 1.2,
      offset: { x: 0, y: 0, z: -0.19 }
    },
    settings: {
      highlightColor: '#ffa84d',
      background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
    },
  },
  {
    id: 'midtown',
    eyebrow: 'Chapter 03',
    title: ['Midtown', 'Signal Lines'],
    body: 'Peak hour becomes a choreography of dots — networks in flux searching for new alignments.',
    modelPath: 'point/server-pc.ply',
    backgroundText: ['Midtown', 'Signal Lines'],
    camera: { pathT: 0.42, yaw: -8, pitch: -4 },
    // transform: {
    //   rotation: { x: -0.05, y: 0, z: -0.1 },
    //   scale: 0.9,
    //   offset: { x: -0.15, y: 0.05, z: 0.1 }
    // },
    settings: {
      highlightColor: '#99d6ff',
    },
  },
  {
    id: 'closer-to-home',
    eyebrow: 'Chapter 04',
    title: ['Closer', 'to Home'],
    body: 'Aotearoa\'s grid is mostly renewable, yet our growing data hubs in Auckland and Southland still draw huge energy to feed global AI demand. Clean doesn\'t mean free — each digital action still leaves a trace.',
    modelPath: 'point/nz2.ply',
    backgroundText: ['Sketching', 'Possible Futures'],
    camera: { pathT: 0.1, yaw: -18, pitch: -6 },
    transform: {
      rotation: { x: 0, y: 0.95, z: 0.05 },
      scale: 1.2,
      offset: { x: 0, y: 0, z: -0.19 }
    },
    settings: {
      highlightColor: '#ffa84d',
      background: { top: '#000000', mid: '#162227', bottom: '#4f6469' },
      useOriginalPointColors: true,
    },
  },
  {
    id: 'nature',
    eyebrow: 'Chapter 05',
    title: ['Sketching', 'Possible Futures'],
    body: 'As the points return to form, the city imagines what it might become under a new collective rhythm.',
    modelPath: 'point/riverV1.ply',
    backgroundText: ['Sketching', 'Possible Futures'],
    camera: { pathT: 0.65, yaw: 0, pitch: -20 },
    transform: {
      rotation: { x: 1.15, y: 0.45, z: 0 },
      scale: 1.2,
      offset: { x: 0.1, y: 0.2, z: -0.1 }
    },
    settings: {
      highlightColor: '#7499E2',
      background: { top: '#8FA4B7', mid: '#1a1a2e', bottom: '#020203' },
      useOriginalPointColors: true,
    },
  },
];

export function getSectionCount() {
  return sections.length;
}
