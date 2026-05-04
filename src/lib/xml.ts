// @ts-ignore the types from @types is out of date, so don't bother
import { default as xmlImpl, type XmlElement, type XmlOptions } from "jstoxml";

// wrap the toXML method to put in some default options
export function toXML(obj?: XmlElement | XmlElement[], options?: XmlOptions): string {
  // NOTE: this is a workaround for the fact that `jstoxml` is another type of module that our current bundler don't support
  // adding trim since `toXML` tends to add new lines before
  return xmlImpl.toXML(obj, { ...options, depth: 100, indent: "" }).trim();
}
