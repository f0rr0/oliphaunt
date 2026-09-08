export function affectedNames(value) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Moon affected query must return an object');
  }
  return Object.keys(value).sort();
}

export function triggeringProjectNames(value) {
  affectedNames(value);
  return Object.entries(value)
    .filter(([, detail]) => {
      if (detail === null || Array.isArray(detail) || typeof detail !== 'object') return false;
      return detail.other === true || (Array.isArray(detail.tasks) && detail.tasks.length > 0);
    })
    .map(([project]) => project)
    .sort();
}

export function triggeringTaskNames(value) {
  affectedNames(value);
  return Object.entries(value)
    .filter(([, detail]) => {
      if (detail === null || Array.isArray(detail) || typeof detail !== 'object') return false;
      return detail.other === true || (Array.isArray(detail.files) && detail.files.length > 0);
    })
    .map(([task]) => task)
    .sort();
}
