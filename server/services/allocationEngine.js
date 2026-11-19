'use strict';
const crypto = require('crypto');

// ─── Allocation Unit ──────────────────────────────────────────────────────────
class AllocationUnit {
  constructor(qNo, letter, part, text = '', title = '', active = true) {
    this.qNo = qNo;
    this.letter = letter;
    this.part = part;         // 'A' or 'B'
    this.text = text;
    this.title = title;
    this.active = active;
  }
  code() { return `${this.qNo}(${this.letter})`; }
  key()  { return `${this.part}:${this.qNo}:${this.letter}`; }
}

// ─── Allocation Pair ──────────────────────────────────────────────────────────
class AllocationPair {
  constructor(partA, partB) {
    this.partA = partA;
    this.partB = partB;
  }
  key()           { return `${this.partA.code()} + ${this.partB.code()}`; }
  normalizedKey() { return `${this.partA.key()}|${this.partB.key()}`; }
}

// ─── Secure Shuffle (Fisher-Yates with crypto.randomInt) ─────────────────────
function secureShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Validate Pair ────────────────────────────────────────────────────────────
function validatePair(unit1, unit2) {
  return (unit1.part === 'A' && unit2.part === 'B') ||
         (unit1.part === 'B' && unit2.part === 'A');
}

// ─── Calculate Capacity ───────────────────────────────────────────────────────
function calculateCapacity(partAUnits, partBUnits, excludedKeys = {}) {
  const activeA = partAUnits.filter(u => u.active);
  const activeB = partBUnits.filter(u => u.active);
  const totalCapacity = activeA.length * activeB.length;
  let excludedCount = 0;
  for (const a of activeA) {
    for (const b of activeB) {
      const pair = new AllocationPair(a, b);
      if (excludedKeys[pair.key()] || excludedKeys[pair.normalizedKey()]) {
        excludedCount++;
      }
    }
  }
  const available = Math.max(0, totalCapacity - excludedCount);
  return {
    part_a_count: activeA.length,
    part_b_count: activeB.length,
    total_capacity: totalCapacity,
    excluded_count: excludedCount,
    available_capacity: available,
  };
}

// ─── Balanced Pairs ───────────────────────────────────────────────────────────
function generateBalancedPairs(activeA, activeB, k, excludedKeys) {
  // Build all valid pairs
  const validPairs = [];
  for (let i = 0; i < activeA.length; i++) {
    for (let j = 0; j < activeB.length; j++) {
      const pair = new AllocationPair(activeA[i], activeB[j]);
      if (!excludedKeys[pair.key()] && !excludedKeys[pair.normalizedKey()]) {
        validPairs.push({ i, j, pair });
      }
    }
  }
  if (k >= validPairs.length) {
    secureShuffle(validPairs);
    return validPairs.map(x => x.pair);
  }

  const usageA = new Array(activeA.length).fill(0);
  const usageB = new Array(activeB.length).fill(0);
  const chosen = [];
  const chosenSet = {};

  secureShuffle(validPairs);

  for (let step = 0; step < k; step++) {
    let bestIdx = -1, bestCost = Infinity;
    for (let ci = 0; ci < validPairs.length; ci++) {
      const { i, j, pair } = validPairs[ci];
      if (chosenSet[pair.key()]) continue;
      const uA = usageA[i], uB = usageB[j];
      const cost = (uA * uA + uB * uB) * 1000 + (uA + uB) * 100 + crypto.randomInt(0, 100);
      if (cost < bestCost) { bestCost = cost; bestIdx = ci; }
    }
    if (bestIdx === -1) throw new Error(`Unable to find next eligible pair at step ${step}.`);
    const sel = validPairs[bestIdx];
    chosenSet[sel.pair.key()] = true;
    chosen.push(sel.pair);
    usageA[sel.i]++;
    usageB[sel.j]++;
  }
  return chosen;
}

// ─── Main Generate ────────────────────────────────────────────────────────────
function generate(partAUnits, partBUnits, students, mode = 'Balanced Random', excludedKeys = {}) {
  const k = students.length;
  if (k <= 0) throw new Error('Student roster cannot be empty.');

  const activeA = partAUnits.filter(u => u.active && u.part === 'A');
  const activeB = partBUnits.filter(u => u.active && u.part === 'B');

  if (!activeA.length || !activeB.length)
    throw new Error('Both Part A and Part B must have at least one active sub-question.');

  const cap = calculateCapacity(activeA, activeB, excludedKeys);
  if (k > cap.available_capacity)
    throw new Error(
      `Combination capacity exceeded! Batch requires ${k} unique combinations, but only ` +
      `${cap.available_capacity} are available (${activeA.length} Part A × ${activeB.length} Part B = ` +
      `${cap.total_capacity}, with ${cap.excluded_count} excluded).`
    );

  // Build eligible pool
  const pool = [];
  for (const a of activeA) {
    for (const b of activeB) {
      const pair = new AllocationPair(a, b);
      if (!excludedKeys[pair.key()] && !excludedKeys[pair.normalizedKey()]) pool.push(pair);
    }
  }

  let chosenPairs;
  if (mode === 'Pure Random') {
    secureShuffle(pool);
    chosenPairs = pool.slice(0, k);
    secureShuffle(chosenPairs);
  } else {
    chosenPairs = generateBalancedPairs(activeA, activeB, k, excludedKeys);
  }

  if (chosenPairs.length !== k) throw new Error(`Generated pair count (${chosenPairs.length}) does not match student count (${k}).`);

  // Verify: no duplicates, valid pairs
  const seenKeys = {};
  for (let idx = 0; idx < chosenPairs.length; idx++) {
    const pKey = chosenPairs[idx].key();
    if (seenKeys[pKey]) throw new Error(`Duplicate combination detected during validation: ${pKey} at index ${idx}`);
    seenKeys[pKey] = true;
    if (!validatePair(chosenPairs[idx].partA, chosenPairs[idx].partB))
      throw new Error(`Invalid pair generated: ${chosenPairs[idx].partA.code()} + ${chosenPairs[idx].partB.code()}`);
  }

  secureShuffle(chosenPairs);

  const partAUsage = {}, partBUsage = {};
  activeA.forEach(a => (partAUsage[a.code()] = 0));
  activeB.forEach(b => (partBUsage[b.code()] = 0));

  const allocations = students.map((student, i) => {
    const pair = chosenPairs[i];
    const partACode = pair.partA.code(), partBCode = pair.partB.code();
    partAUsage[partACode]++;
    partBUsage[partBCode]++;
    return {
      seq: i + 1,
      roll_no:  student.roll_no || student.roll || '',
      student_name: student.name || '',
      part_a_q:      pair.partA.qNo,
      part_a_letter: pair.partA.letter,
      part_a_code:   partACode,
      part_a_text:   pair.partA.text,
      part_b_q:      pair.partB.qNo,
      part_b_letter: pair.partB.letter,
      part_b_code:   partBCode,
      part_b_text:   pair.partB.text,
      pair_key:      pair.key(),
      display_combination: `${partACode} + ${partBCode}`,
    };
  });

  return {
    mode, student_count: k,
    part_a_count: activeA.length, part_b_count: activeB.length,
    total_capacity: cap.total_capacity, available_capacity: cap.available_capacity,
    used_combinations: allocations.length,
    remaining_combinations: cap.available_capacity - allocations.length,
    duplicate_count: 0, unassigned_count: 0, validation_status: 'valid',
    part_a_usage: partAUsage, part_b_usage: partBUsage, allocations,
  };
}

module.exports = { AllocationUnit, AllocationPair, secureShuffle, validatePair, calculateCapacity, generate };
