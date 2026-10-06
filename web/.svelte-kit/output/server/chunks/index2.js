import { s as stores, p as page$2, u as updated$2 } from "./client.js";
import "clsx";
const page$1 = {
  get error() {
    return page$2.error;
  },
  get status() {
    return page$2.status;
  }
};
const updated$1 = {
  get current() {
    return updated$2.current;
  },
  check: stores.updated.check
};
const page = page$1;
const updated = updated$1;
export {
  page as p,
  updated as u
};
