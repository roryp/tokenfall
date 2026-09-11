const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 6, maximumFractionDigits: 8 });

export const formatMoney = (value: number | null) => value === null ? '--' : moneyFormat.format(value);
export const formatEfficiency = (value: number | null) => value === null ? '--' : value.toLocaleString(undefined, { maximumFractionDigits: 0 });