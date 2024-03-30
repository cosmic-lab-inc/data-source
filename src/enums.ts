/**
 * Convert to Typescript Enum to an Anchor enum
 *
 * @param enumDef The enum definition
 * @param valueToConvert The enum value that needs to be converted
 * @returns the anchor enum
 */
export const getAnchorEnum = <E, K extends string>(
  enumDef: { [key in K]: E },
  valueToConvert: E
) => {
  const enumValues = Object.entries(enumDef);
  for (let index = 0; index < enumValues.length; index++) {
    const element = enumValues[index];
    if (element) {
      if (valueToConvert === element[1]) {
        const isAllCaps = element[0].toUpperCase() === element[0];
        const key = isAllCaps
          ? element[0].toLowerCase()
          : element[0].charAt(0).toLowerCase() + element[0].slice(1);
        return { [key]: {} } as never;
      }
    }
  }
  throw new Error(`${valueToConvert} is not found in the enum`);
};

/**
 * Convert an enum to a number value
 *
 * @param enumDef The enum definition
 * @param valueToConvert The enum value that needs to be converted
 * @param indexOffset The index offset (typically this value is 1)
 * @returns the numerical value of the enum value
 */
export const getNumberFromEnum = <E, K extends string>(
  enumDef: { [key in K]: E },
  valueToConvert: E,
  indexOffset = 1
) => {
  const enumValues = Object.entries(enumDef);
  for (let index = 0; index < enumValues.length; index++) {
    const element = enumValues[index];
    if (element) {
      if (valueToConvert === element[1]) {
        return (element[1] as number) + indexOffset;
      }
    }
  }
  throw new Error(`${valueToConvert} is not found in the enum`);
};
