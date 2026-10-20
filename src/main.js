import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.78;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050a13);
scene.fog = new THREE.FogExp2(0x050a13, 0.012);
const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 180);
const hemi = new THREE.HemisphereLight(0x9fc7ef, 0x101827, 0.48);
scene.add(hemi);

function spotlight(position, color, intensity, angle) {
  const light = new THREE.SpotLight(color, intensity, 42, angle, 0.58, 1.2);
  light.position.set(...position);
  light.target.position.set(0, 1.05, 0);
  scene.add(light, light.target);
  return light;
}
spotlight([-5.8, 12, -5.8], 0x8ac8ff, 110, Math.PI / 5.5);
spotlight([5.8, 12, -5.8], 0x78aaff, 110, Math.PI / 5.5);
spotlight([-5.8, 12, 5.8], 0xb7dcff, 125, Math.PI / 5.5);
spotlight([5.8, 12, 5.8], 0xffc275, 80, Math.PI / 5.5);
const fill = new THREE.PointLight(0x2767b9, 5, 22, 2);
fill.position.set(0, 5.5, 0);
scene.add(fill);

const loader = new GLTFLoader();
const keys = new Set();
const clock = new THREE.Clock();
const cameraTarget = new THREE.Vector3();
const desiredCamera = new THREE.Vector3();
const moveDirection = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const ringFloorY = 1.12;
const jumpGravity = 16.8;
let player = null;
let characterRig = null;
let characterSkinnedMeshes = [];
let mixer = null;
let actions = {};
let activeLocomotion = '';
let oneShot = null;
let cameraYaw = 0;
let cameraPitch = 0.17;
let cameraDistance = 5.9;
let dragging = false;
let lastX = 0;
let lastY = 0;
let airborne = false;
let jumpVelocity = 0;
let attackCooldown = 0;
let queuedRecovery = null;
let toastTimer;

// The three in-place cycles are 4/3, 14/15, and 2/3 seconds long.
// Matching travel per full cycle keeps the feet from sliding against the floor.
const travelPerLoop = 2.05;
const movementSpeeds = {
  Walk_Loop: travelPerLoop / (4 / 3),
  Jog_Fwd_Loop: travelPerLoop / (14 / 15),
  Sprint_Loop: travelPerLoop / (2 / 3),
  Idle_Loop: 0
};

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 720);
}

function setLocomotion(name, fade = 0.16) {
  if (oneShot || !actions[name] || activeLocomotion === name) return;
  const next = actions[name];
  const previous = actions[activeLocomotion];
  next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
  if (previous) previous.fadeOut(fade);
  activeLocomotion = name;
}

function playOneShot(name, { replace = false, timeScale = 1, fadeIn = 0.03, fadeOut = 0.04 } = {}) {
  if (!mixer || !actions[name] || (oneShot && !replace)) return false;
  // INSTANT transition for snappy feel - no blending delay!
  if (oneShot) oneShot.stop(); // Hard stop, no fade
  if (activeLocomotion && actions[activeLocomotion]) actions[activeLocomotion].fadeOut(fadeIn);
  const action = actions[name];
  action.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.fadeIn(fadeIn).play(); // Minimal fade for instant response
  oneShot = action;
  activeLocomotion = '';
  return true;
}

function syncLocomotion() {
  if (!player || oneShot || airborne) return;
  const moving = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].some((key) => keys.has(key));
  const running = keys.has('shift') || keys.has('shiftleft') || keys.has('shiftright');
  const jogging = keys.has('control') || keys.has('ctrl');
  setLocomotion(running && moving ? 'Sprint_Loop' : jogging && moving ? 'Jog_Fwd_Loop' : moving ? 'Walk_Loop' : 'Idle_Loop');
}

// REMOVED: arm-only clips cause floaty, weightless punches!
// Real fighting games (Bully, GTA, Tekken) use FULL BODY animation for proper weight transfer
// Body rotation, hip twist, and leg planted create the punch power and snap

function attack(name, label) {
  if (attackCooldown > 0 || !player || airborne || oneShot) return;
  const profiles = {
    // Jab: lightning fast like fighting games (3-5 frame startup @ 60fps = ~0.05-0.08s)
    // With full body weight transfer - snap punch with hip rotation!
    Punch_Jab: { timeScale: 4.5, fadeIn: 0.03, fadeOut: 0.04 },
    // Cross: power punch with body rotation (8-12 frames startup = ~0.13-0.20s)
    // Full torso twist for maximum impact!
    Punch_Cross: { timeScale: 3.8, fadeIn: 0.04, fadeOut: 0.05 },
    // Hook: arc punch with hip drive (12-15 frames = ~0.20-0.25s)
    // Wide swing needs full body commitment!
    Melee_Hook: { timeScale: 3.5, recovery: 'Melee_Hook_Rec', recoveryScale: 4.0, fadeIn: 0.04, fadeOut: 0.04 }
  };
  const profile = profiles[name];
  const mainAction = actions[name];
  if (!profile || !mainAction) return;
  const recoveryAction = profile.recovery ? actions[profile.recovery] : null;
  const recoveryScale = profile.recoveryScale || 1;
  if (playOneShot(name, { timeScale: profile.timeScale, fadeIn: profile.fadeIn, fadeOut: profile.fadeOut })) {
    queuedRecovery = recoveryAction ? { name: profile.recovery, timeScale: recoveryScale, fadeIn: profile.fadeIn, fadeOut: profile.fadeOut } : null;
    attackCooldown = 0.05; // Fighting game standard: 3-5 frame window
    showToast(label);
  }
}

function startJump() {
  if (!player || airborne || oneShot || !actions['Jump_Start'] || !actions['Jump_Land']) return;
  airborne = true;
  jumpVelocity = 4.2;
  playOneShot('Jump_Start', { timeScale: 3.5, fadeIn: 0.02, fadeOut: 0.03 }); // Instant jump like Bully/GTA
}

function makeFallbackCharacter() {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: 0x376287, roughness: 0.54 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.76, 5, 8), suit);
  body.position.y = 1.08;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd4a27d }));
  head.position.y = 1.94;
  group.add(body, head);
  return group;
}

async function loadAssets() {
  $('loadingStatus').textContent = 'Membuka ring dan tribun…';
  const arenaAsset = await loader.loadAsync('/assets/arena/boxing-arena.glb');
  arenaAsset.scene.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = false;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.side = THREE.DoubleSide;
        const name = material.name.toLowerCase();
        if (name.includes('championship blue')) material.color.set(0x0b3f91);
        if (name.includes('electric blue')) material.color.set(0x185fae);
        if (name.includes('championship blue') || name.includes('electric blue')) {
          if (material.emissive) material.emissive.set(0x000000);
          material.emissiveIntensity = 0;
        }
      }
    }
  });
  scene.add(arenaAsset.scene);

  $('loadingStatus').textContent = 'Memanggil petarung…';
  const [characterResult, animationResult, combatAnimationResult] = await Promise.allSettled([
    loader.loadAsync('/assets/character/Superhero_Male_FullBody.gltf'),
    loader.loadAsync('/assets/animations/UAL1_Standard.glb'),
    loader.loadAsync('/assets/animations/UAL2_Standard.glb')
  ]);
  const characterAsset = characterResult.status === 'fulfilled' ? characterResult.value : null;
  const animationAsset = animationResult.status === 'fulfilled' ? animationResult.value : null;
  const combatAnimationAsset = combatAnimationResult.status === 'fulfilled' ? combatAnimationResult.value : null;
  characterRig = characterAsset?.scene || makeFallbackCharacter();
  characterRig.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material?.color) material.color.multiplyScalar(0.84);
      if (material?.emissive) material.emissive.multiplyScalar(0.55);
    }
  });
  characterRig.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(characterRig);
  const height = Math.max(0.01, bounds.max.y - bounds.min.y);
  characterRig.scale.setScalar(1.78 / height);
  characterRig.updateMatrixWorld(true);
  const groundedBounds = new THREE.Box3().setFromObject(characterRig);
  characterRig.position.y -= groundedBounds.min.y;
  characterSkinnedMeshes = [];
  characterRig.traverse((object) => {
    if (object.isSkinnedMesh) characterSkinnedMeshes.push(object);
  });

  player = new THREE.Group();
  player.position.set(0, 1.12, 0.8);
  player.add(characterRig);
  scene.add(player);

  if (animationAsset?.animations?.length) {
    mixer = new THREE.AnimationMixer(characterRig);
    const desired = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Jump_Start', 'Jump_Land', 'Punch_Jab', 'Punch_Cross', 'Hit_Head', 'Hit_Chest'];
    for (const name of desired) {
      const clip = animationAsset.animations.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (clip) actions[name] = mixer.clipAction(clip); // FULL BODY - no more arm-only filter!
    }
    for (const name of ['Melee_Hook', 'Melee_Hook_Rec']) {
      const clip = combatAnimationAsset?.animations?.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (clip) actions[name] = mixer.clipAction(clip); // FULL BODY for proper weight transfer!
    }
    mixer.addEventListener('finished', (event) => {
      if (event.action === oneShot) {
        if (queuedRecovery) {
          const next = queuedRecovery;
          queuedRecovery = null;
          playOneShot(next.name, { replace: true, timeScale: next.timeScale, fadeIn: next.fadeIn, fadeOut: next.fadeOut });
          return;
        }
        // INSTANT snap back to idle - fighting game standard!
        if (['Punch_Jab', 'Punch_Cross', 'Melee_Hook', 'Melee_Hook_Rec'].includes(event.action.getClip().name)) {
          event.action.stop(); // Hard stop for instant combo readiness
        }
        oneShot = null;
        syncLocomotion();
      }
    });
    setLocomotion('Idle_Loop', 0);
  }
  if (!characterAsset) {
    $('error').textContent = 'Model petarung tidak termuat. Pastikan laptop tersambung ke internet lalu muat ulang.';
    $('error').classList.remove('hidden');
  }
}

function updatePlayer(dt) {
  if (!player) return;
  attackCooldown = Math.max(0, attackCooldown - dt);
  const forwardInput = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const sideInput = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  forward.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
  right.set(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
  moveDirection.copy(forward).multiplyScalar(forwardInput).addScaledVector(right, sideInput);
  if (moveDirection.lengthSq() > 0) moveDirection.normalize();

  if (airborne) {
    player.position.y += jumpVelocity * dt;
    jumpVelocity -= jumpGravity * dt;
    if (player.position.y <= ringFloorY && jumpVelocity < 0) {
      player.position.y = ringFloorY;
      jumpVelocity = 0;
      airborne = false;
      playOneShot('Jump_Land', { replace: true, timeScale: 3.2, fadeIn: 0.02, fadeOut: 0.03 });
    }
  } else if (moveDirection.lengthSq() > 0 && !oneShot) {
    const speed = movementSpeeds[keys.has('shift') ? 'Sprint_Loop' : (keys.has('control') || keys.has('ctrl')) ? 'Jog_Fwd_Loop' : 'Walk_Loop'];
    player.position.addScaledVector(moveDirection, speed * dt);
    const rotation = Math.atan2(moveDirection.x, moveDirection.z);
    let delta = rotation - player.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    player.rotation.y += delta * (1 - Math.exp(-12 * dt));
  }
  // Keep the character inside the ropes.
  player.position.x = THREE.MathUtils.clamp(player.position.x, -3.35, 3.35);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -3.35, 3.35);
  if (mixer) mixer.update(dt);
  if (!airborne && characterRig) {
    player.updateMatrixWorld(true);
    for (const skinnedMesh of characterSkinnedMeshes) skinnedMesh.computeBoundingBox();
    const characterBounds = new THREE.Box3().setFromObject(characterRig);
    player.position.y += ringFloorY - characterBounds.min.y;
  }
  syncLocomotion();
}

function updateCamera(dt) {
  if (!player) return;
  cameraTarget.set(player.position.x, player.position.y + 1.05, player.position.z);
  const horizontal = Math.cos(cameraPitch) * cameraDistance;
  desiredCamera.set(
    cameraTarget.x + Math.sin(cameraYaw) * horizontal,
    cameraTarget.y + Math.sin(cameraPitch) * cameraDistance + 0.28,
    cameraTarget.z + Math.cos(cameraYaw) * horizontal
  );
  camera.position.lerp(desiredCamera, 1 - Math.exp(-7 * dt));
  camera.lookAt(cameraTarget);
}

function onKeyDown(event) {
  const key = event.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
  if (!keys.has(key)) {
    if (key === 'j') attack('Punch_Jab', 'JAB');
    if (key === 'k') attack('Punch_Cross', 'CROSS');
    if (key === 'l') attack('Melee_Hook', 'HOOK');
    if (key === ' ') startJump();
  }
  keys.add(key);
}
function onKeyUp(event) { keys.delete(event.key.toLowerCase()); }
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointermove', (event) => {
  if ($('welcome').classList.contains('hidden') === false) return;
  const locked = document.pointerLockElement === canvas;
  if (!locked && !dragging) return;
  const dx = locked ? event.movementX : event.clientX - lastX;
  const dy = locked ? event.movementY : event.clientY - lastY;
  cameraYaw -= dx * 0.0045;
  cameraPitch = THREE.MathUtils.clamp(cameraPitch + dy * 0.0027, -0.04, 0.66);
  lastX = event.clientX;
  lastY = event.clientY;
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  cameraDistance = THREE.MathUtils.clamp(cameraDistance + event.deltaY * 0.006, 4.3, 10.5);
}, { passive: false });
$('startButton').addEventListener('click', () => {
  $('welcome').classList.add('hidden');
  $('hud').classList.remove('hidden');
  canvas.requestPointerLock?.();
  showToast('LATIHAN DIMULAI');
});

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
}
window.addEventListener('resize', resize);

async function init() {
  try {
    await loadAssets();
    $('loading').classList.add('done');
    $('welcome').classList.remove('hidden');
    animate();
  } catch (error) {
    console.error(error);
    $('loadingStatus').textContent = 'Arena belum berhasil dibuka. Coba muat ulang halaman.';
    $('error').textContent = 'Periksa apakah file boxing-arena.glb ada di public/assets/arena.';
    $('error').classList.remove('hidden');
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.04);
  updatePlayer(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}

init();
