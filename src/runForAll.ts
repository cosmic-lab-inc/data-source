// import { expect } from 'chai';

export function combineObjectArrays<T, TK extends string, U, UK extends string>(
  arr1: { [P in TK]: T }[],
  arr2: { [P in UK]: U }[]
): ({ [P in TK]: T } & { [P in UK]: U })[] {
  return arr1.map((obj1) => arr2.map((obj2) => ({ ...obj1, ...obj2 }))).flat();
}

export function runForAll<T extends Record<string, unknown>, O>(
  runArgs: { [P in keyof T]: T[P][] },
  func: (arg: T) => O
): O[] {
  const runConfigs = Object.keys(runArgs)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    .map((key) => runArgs[key]!.map((val) => ({ [key]: val })))
    .reduce((prev, curr) => combineObjectArrays(prev, curr), [{}]);
  return runConfigs.map((config) => func(config as T));
}

// it('test runForAll', () => {
//   const from = {
//     canIncrement: [true, false],
//     canDecrement: [true, false],
//     licenseType: ['none', 'burn', 'vault'],
//   };
//   const into = [
//     {
//       canIncrement: true,
//       canDecrement: true,
//       licenseType: 'none',
//     },
//     {
//       canIncrement: true,
//       canDecrement: true,
//       licenseType: 'burn',
//     },
//     {
//       canIncrement: true,
//       canDecrement: true,
//       licenseType: 'vault',
//     },
//     {
//       canIncrement: true,
//       canDecrement: false,
//       licenseType: 'none',
//     },
//     {
//       canIncrement: true,
//       canDecrement: false,
//       licenseType: 'burn',
//     },
//     {
//       canIncrement: true,
//       canDecrement: false,
//       licenseType: 'vault',
//     },
//     {
//       canIncrement: false,
//       canDecrement: true,
//       licenseType: 'none',
//     },
//     {
//       canIncrement: false,
//       canDecrement: true,
//       licenseType: 'burn',
//     },
//     {
//       canIncrement: false,
//       canDecrement: true,
//       licenseType: 'vault',
//     },
//     {
//       canIncrement: false,
//       canDecrement: false,
//       licenseType: 'none',
//     },
//     {
//       canIncrement: false,
//       canDecrement: false,
//       licenseType: 'burn',
//     },
//     {
//       canIncrement: false,
//       canDecrement: false,
//       licenseType: 'vault',
//     },
//   ];
//
//   expect(runForAll(from, (arg) => arg)).to.deep.equal(into);
// });
