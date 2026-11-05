let maintenance = false;

export function setMaintenance(value: boolean) {
  maintenance = value;
}

export function inMaintenance(): boolean {
  return maintenance;
}
