const ALL_SOUNDS = [
  { id: "default-click", path: "sounds/click.mp3", label: "Default Click" },
  { id: "dragon-click", path: "sounds/dragon-studio-mouse-click-398644.mp3", label: "Dragon Click" },
  { id: "dragon-sfx", path: "sounds/dragon-studio-mouse-click-sfx-444806.mp3", label: "Dragon SFX" },
  { id: "soft-click", path: "sounds/matthewvakaliuk73627-mouse-click-290204.mp3", label: "Soft Click" },
  { id: "double-click", path: "sounds/mixkit-fast-double-click-on-mouse-275.wav", label: "Double Click" },
  { id: "modern-select", path: "sounds/mixkit-modern-technology-select-3124.wav", label: "Modern Select" },
  { id: "sci-fi", path: "sounds/mixkit-sci-fi-click-900.wav", label: "Sci-Fi Click" },
  { id: "select-click", path: "sounds/mixkit-select-click-1109.wav", label: "Select Click" },
  { id: "reality-click", path: "sounds/soundreality-sound-of-mouse-click-4-478760.mp3", label: "Reality Click" },
  { id: "mechanical-02", path: "sounds/universfield-computer-mouse-click-02-383961.mp3", label: "Mechanical 02" },
  { id: "mechanical", path: "sounds/universfield-computer-mouse-click-352734.mp3", label: "Mechanical" },
  { id: "subtle-click", path: "sounds/universfield-mouse-click-351398.mp3", label: "Subtle Click" },
];

let currentDispose = null;
let settingDispose = null;

function registerSelected(api, soundId) {
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
  const sound = ALL_SOUNDS.find((s) => s.id === soundId) || ALL_SOUNDS[0];
  currentDispose = api.registerClickSound({
    path: sound.path,
    volume: 1.0,
  });
}

export function activate(api) {
  const savedId = api.getSetting("selectedClickSound") || "default-click";
  registerSelected(api, savedId);

  settingDispose = api.onSettingChange((settingId, value) => {
    if (settingId === "selectedClickSound") {
      registerSelected(api, value);
    }
  });
}

export function deactivate() {
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
  if (settingDispose) {
    settingDispose();
    settingDispose = null;
  }
}
