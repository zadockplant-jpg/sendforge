// Paperwork filled out and signed in the crew portal: the official IRS, Michigan Treasury and
// USCIS forms (vendor/forms), and a direct deposit authorization. Each form is a list of web
// fields in the order the paper form asks for them, a check of what was typed, and where each
// answer goes on the official PDF.
//
// The official PDFs are filled by drawing each answer inside its form field's box and then
// removing the fields, so the signed copy is flat and reads the same everywhere. The signature
// (drawn, or the typed name) goes on the form's own signature line, with the date beside it.
//
//   W-4 (2026)   vendor/forms/fw4-2026.pdf   IRS, as published
//   MI-W4        vendor/forms/mi-w4.pdf      Michigan Treasury (Rev. 12-20), re-saved with PyMuPDF
//                                            because pdf-lib cannot read the published file
//   I-9          vendor/forms/i-9.pdf        USCIS (edition 01/20/25, expires 05/31/2027)
//   W-9          vendor/forms/fw9.pdf        IRS (Rev. March 2024)
// Replace a file when the agency publishes a new edition, and check the field names below.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, StandardFonts, rgb } from "./vendor/pdf-lib.js";

const INK = rgb(0.05, 0.05, 0.1);
const FORMS_DIR = fileURLToPath(new URL("./vendor/forms/", import.meta.url));

// ---------- Answers: what each kind of field accepts ----------

const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" "));

function digits(value) {
  return String(value || "").replace(/\D/gu, "");
}

// A dollar amount typed as "1,250" or "1250.50" becomes cents; blank is null.
export function parseDollars(value) {
  const text = String(value || "").replace(/[$,\s]/gu, "");
  if (!text) return null;
  const match = text.match(/^(\d{1,7})(?:\.(\d{1,2}))?$/u);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
}

function validRouting(number) {
  if (!/^\d{9}$/u.test(number)) return false;
  const d = [...number].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const CHECKS = {
  text: (value, field) => (value.length <= (field.max || 120) ? value : undefined),
  ssn: (value) => (/^\d{9}$/u.test(digits(value)) ? digits(value).replace(/^(\d{3})(\d{2})(\d{4})$/u, "$1-$2-$3") : undefined),
  ein: (value) => (/^\d{9}$/u.test(digits(value)) ? digits(value).replace(/^(\d{2})(\d{7})$/u, "$1-$2") : undefined),
  date: (value) => (realDate(value) ? value : undefined),
  money: (value) => {
    const cents = parseDollars(value);
    return cents === undefined ? undefined : cents;
  },
  count: (value) => (/^\d{1,2}$/u.test(value) ? Number(value) : undefined),
  state: (value) => (STATES.has(value.toUpperCase()) ? value.toUpperCase() : undefined),
  zip: (value) => (/^\d{5}(?:-?\d{4})?$/u.test(value) ? value : undefined),
  phone: (value) => (digits(value).length >= 10 && digits(value).length <= 15 ? value : undefined),
  email: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(value) && value.length <= 254 ? value : undefined),
  routing: (value) => (validRouting(digits(value)) ? digits(value) : undefined),
  account: (value) => (/^\d{4,17}$/u.test(digits(value)) ? digits(value) : undefined),
  choice: (value, field) => (field.options.some(([key]) => key === value) ? value : undefined),
  check: (value) => value === "yes"
};

const PROBLEMS = {
  ssn: "a 9-digit Social Security number",
  ein: "a 9-digit employer identification number",
  date: "a date",
  money: "a dollar amount",
  count: "a whole number",
  state: "a two-letter state",
  zip: "a 5- or 9-digit ZIP code",
  phone: "a phone number with area code",
  email: "an email address",
  routing: "the 9-digit routing number from a check (it did not check out)",
  account: "an account number of 4 to 17 digits",
  choice: "one of the choices"
};

// Reads a form's answers from a submitted form. Returns { values } or { error, values } (the
// typed answers, to show the form again).
export function readAnswers(spec, form, { section = null } = {}) {
  const values = {};
  const typed = {};
  for (const group of spec.sections) {
    if (section && group.part !== section) continue;
    for (const field of group.fields) {
      const raw = field.type === "check" ? (form.get(field.name) === "yes" ? "yes" : "") : String(form.get(field.name) || "").trim();
      typed[field.name] = raw;
      if (!raw) {
        if (field.type === "check") values[field.name] = false;
        else if (field.required) return { error: `Enter ${field.label.replace(/\s*\(.*\)$/u, "").toLowerCase()}.`, values: typed, field: field.name };
        else values[field.name] = field.type === "money" ? null : "";
        continue;
      }
      const checked = CHECKS[field.type](raw, field);
      if (checked === undefined) return { error: `${field.label.replace(/\s*\(.*\)$/u, "")}: enter ${PROBLEMS[field.type] || "a shorter answer"}.`, values: typed, field: field.name };
      values[field.name] = checked;
    }
  }
  const problem = spec.check ? spec.check(values, { section }) : "";
  if (problem) return { error: problem, values: typed };
  return { values };
}

// ---------- Printing answers ----------

export function slashDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "";
}

function dollars(cents, { whole = true } = {}) {
  if (cents === null || cents === undefined || cents === "") return "";
  const value = Number(cents) / 100;
  return value.toLocaleString("en-US", { minimumFractionDigits: whole && Number(cents) % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

const text = (field, value, options = {}) => (value === "" || value === null || value === undefined ? null : { field, text: String(value), ...options });
const mark = (field, widget = 0) => ({ field, check: true, widget });

// ---------- The forms ----------

const W4_PREFIX = "topmostSubform[0].Page1[0].";

export const FORMS = {
  w4: {
    key: "w4",
    who: "employee",
    title: "Form W-4 (2026)",
    heading: "Employee's Withholding Certificate",
    summary: "Federal income tax withholding, for the IRS.",
    template: "fw4-2026.pdf",
    intro: "Complete Form W-4 so My Home Builder can withhold the correct federal income tax from your pay. Complete Steps 2 through 4 only if they apply to you; otherwise leave them blank and sign. For the most accurate withholding, you can use the IRS estimator at www.irs.gov/W4App.",
    sections: [
      {
        heading: "Step 1: Enter personal information",
        fields: [
          { name: "firstName", label: "First name and middle initial", type: "text", required: true, max: 60, autocomplete: "given-name" },
          { name: "lastName", label: "Last name", type: "text", required: true, max: 60, autocomplete: "family-name" },
          { name: "address", label: "Address", type: "text", required: true, max: 100, autocomplete: "street-address" },
          { name: "cityStateZip", label: "City or town, state, and ZIP code", type: "text", required: true, max: 100 },
          { name: "ssn", label: "Social Security number", type: "ssn", required: true, hint: "Does your name match the name on your Social Security card? If not, contact SSA at 800-772-1213 or go to www.ssa.gov to make sure you get credit for your earnings." },
          {
            name: "filingStatus", label: "Filing status", type: "choice", required: true, options: [
              ["single", "Single or Married filing separately"],
              ["married", "Married filing jointly or Qualifying surviving spouse"],
              ["head", "Head of household (Check only if you're unmarried and pay more than half the costs of keeping up a home for yourself and a qualifying individual.)"]
            ]
          }
        ]
      },
      {
        heading: "Step 2: Multiple jobs or spouse works",
        hint: "Complete this step if you (1) hold more than one job at a time, or (2) are married filing jointly and your spouse also works. Use the estimator at www.irs.gov/W4App, or the Multiple Jobs Worksheet on page 3 of the form, and enter the result in Step 4(c) below; or check the box below.",
        fields: [
          { name: "twoJobs", label: "Step 2(c): There are only two jobs total. (Do the same on Form W-4 for the other job.)", type: "check" }
        ]
      },
      {
        heading: "Step 3: Claim dependent and other credits",
        hint: "If your total income will be $200,000 or less ($400,000 or less if married filing jointly).",
        fields: [
          { name: "children", label: "Number of qualifying children under age 17 (each counts $2,200)", type: "count" },
          { name: "dependents", label: "Number of other dependents (each counts $500)", type: "count" },
          { name: "otherCredits", label: "Amount for other credits ($)", type: "money" }
        ]
      },
      {
        heading: "Step 4 (optional): Other adjustments",
        fields: [
          { name: "otherIncome", label: "4(a) Other income (not from jobs) for the year ($)", type: "money", hint: "Income you want tax withheld for that won't have withholding, such as interest, dividends and retirement income." },
          { name: "deductions", label: "4(b) Deductions ($)", type: "money", hint: "The result of the Deductions Worksheet on page 4 of the form. If you skip this line, your withholding is based on the standard deduction." },
          { name: "extraWithholding", label: "4(c) Extra withholding each pay period ($)", type: "money" }
        ]
      },
      {
        heading: "Exempt from withholding",
        fields: [
          { name: "exempt", label: "I claim exemption from withholding for 2026, and I certify that I meet both of the conditions for exemption for 2026. I understand I will need to submit a new Form W-4 for 2027.", type: "check" }
        ]
      }
    ],
    attestation: "Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.",
    fill(values, { employer, worker }) {
      const credit3a = (values.children || 0) * 220000;
      const credit3b = (values.dependents || 0) * 50000;
      const total3 = credit3a + credit3b + (values.otherCredits || 0);
      return [
        text(`${W4_PREFIX}Step1a[0].f1_01[0]`, values.firstName),
        text(`${W4_PREFIX}Step1a[0].f1_02[0]`, values.lastName),
        text(`${W4_PREFIX}Step1a[0].f1_03[0]`, values.address),
        text(`${W4_PREFIX}Step1a[0].f1_04[0]`, values.cityStateZip),
        text(`${W4_PREFIX}f1_05[0]`, values.ssn),
        mark(`${W4_PREFIX}c1_1[${{ single: 0, married: 1, head: 2 }[values.filingStatus]}]`),
        values.twoJobs ? mark(`${W4_PREFIX}c1_2[0]`) : null,
        credit3a ? text(`${W4_PREFIX}Step3_ReadOrder[0].f1_06[0]`, dollars(credit3a)) : null,
        credit3b ? text(`${W4_PREFIX}Step3_ReadOrder[0].f1_07[0]`, dollars(credit3b)) : null,
        total3 ? text(`${W4_PREFIX}f1_08[0]`, dollars(total3)) : null,
        text(`${W4_PREFIX}f1_09[0]`, dollars(values.otherIncome)),
        text(`${W4_PREFIX}f1_10[0]`, dollars(values.deductions)),
        text(`${W4_PREFIX}f1_11[0]`, dollars(values.extraWithholding)),
        values.exempt ? mark(`${W4_PREFIX}c1_3[0]`) : null,
        text(`${W4_PREFIX}f1_12[0]`, [employer.legalName, employerAddress(employer)].filter(Boolean).join(", "), { lines: 2 }),
        text(`${W4_PREFIX}f1_13[0]`, slashDate(worker.startDate)),
        text(`${W4_PREFIX}f1_14[0]`, employer.ein)
      ];
    },
    signature: { page: 0, box: [100, 91.5, 345, 18], date: [465, 94] }
  },

  miw4: {
    key: "miw4",
    who: "employee",
    title: "Form MI-W4",
    heading: "Employee's Michigan Withholding Exemption Certificate",
    summary: "Michigan income tax withholding, for Michigan Treasury.",
    template: "mi-w4.pdf",
    intro: "This certificate is for Michigan income tax withholding purposes only. If you fail or refuse to file this form, your employer must withhold Michigan income tax from your wages without allowance for any exemptions.",
    sections: [
      {
        heading: "About you",
        fields: [
          { name: "ssn", label: "1. Full Social Security number", type: "ssn", required: true },
          { name: "birthDate", label: "2. Date of birth", type: "date", required: true },
          { name: "name", label: "3. Name (first, middle initial, last)", type: "text", required: true, max: 80, autocomplete: "name" },
          { name: "license", label: "4. Driver's license number or state ID", type: "text", max: 30 },
          { name: "address", label: "Home address (No., street, P.O. box or rural route)", type: "text", required: true, max: 100, autocomplete: "street-address" },
          { name: "city", label: "City or town", type: "text", required: true, max: 60, autocomplete: "address-level2" },
          { name: "state", label: "State", type: "state", required: true, autocomplete: "address-level1" },
          { name: "zip", label: "ZIP code", type: "zip", required: true, autocomplete: "postal-code" },
          { name: "newEmployee", label: "5. Are you a new employee?", type: "choice", required: true, options: [["yes", "Yes"], ["no", "No"]] },
          { name: "hireDate", label: "If yes, date of hire", type: "date" }
        ]
      },
      {
        heading: "Exemptions and additional withholding",
        hint: "Most people claim one exemption for themselves and one for each dependent. See the instructions on page 2 of the form.",
        fields: [
          { name: "exemptions", label: "6. Number of personal and dependent exemptions", type: "count" },
          { name: "additional", label: "7. Additional amount you want deducted from each pay, if My Home Builder agrees (whole dollars)", type: "money" }
        ]
      },
      {
        heading: "8. I claim exemption from withholding because (see instructions)",
        hint: "Leave these blank unless one applies to you.",
        fields: [
          { name: "exemptNoLiability", label: "a. A Michigan income tax liability is not expected this year.", type: "check" },
          { name: "exemptWages", label: "b. Wages are exempt from withholding.", type: "check" },
          { name: "exemptWagesExplain", label: "Explain why your wages are exempt", type: "text", max: 80 },
          { name: "exemptZone", label: "c. Permanent home (domicile) is located in a Renaissance Zone.", type: "check" },
          { name: "zoneName", label: "The Renaissance Zone", type: "text", max: 60 }
        ]
      }
    ],
    check(values) {
      if (values.newEmployee === "yes" && !values.hireDate) return "Enter your date of hire.";
      if (values.exemptWages && !values.exemptWagesExplain) return "Explain why your wages are exempt from withholding.";
      if (values.exemptZone && !values.zoneName) return "Enter the Renaissance Zone where your permanent home is.";
      if (values.additional !== null && values.additional % 100 !== 0) return "Enter the additional amount in whole dollars.";
      return "";
    },
    attestation: "Under penalty of perjury, I certify that the number of withholding exemptions claimed on this certificate does not exceed the number I am allowed to claim. If claiming exemption from withholding, I certify that I do not anticipate a Michigan income tax liability this year.",
    fill(values, { employer }) {
      return [
        text("1 Full Social Security Number", values.ssn),
        text("2 Date of Birth", slashDate(values.birthDate)),
        text("3 Name First Middle Initial Last", values.name),
        text("4 Drivers License Number or State ID", values.license),
        text("Home Address No Street PO Box or Rural Route", values.address),
        text("City or Town", values.city),
        text("State", values.state),
        text("ZIP Code", values.zip),
        mark("5 Are you a new employee", values.newEmployee === "yes" ? 0 : 1),
        values.newEmployee === "yes" ? text("mmddyyyy", slashDate(values.hireDate)) : null,
        values.exemptions !== "" && values.exemptions !== null ? text("Enter the number of personal and dependent exemptions", String(values.exemptions)) : null,
        values.additional ? text("Additional amount you want deducted from each pay", String(Math.round(values.additional / 100)), { align: "right" }) : null,
        values.exemptNoLiability ? mark("A Michigan income tax liability is not expected this year") : null,
        values.exemptWages ? mark("b Wages are exempt from withholding") : null,
        text("Explain Wages are exempt from withholding", values.exemptWagesExplain),
        values.exemptZone ? mark("C  Permanent home domicile is located in the following Renaissance Zone") : null,
        text("Permanent home domicile is located in the following Renaissance Zone", values.zoneName),
        text("10 Employers Name", employer.legalName),
        text("11 Federal Employer Identification Number", employer.ein),
        text("Address", employer.street),
        text("City", employer.city),
        text("State_2", employer.state),
        text("ZIP Code_2", employer.zip),
        text("Name of Contact Person", employer.contactName),
        text("Contact Phone Number", employer.contactPhone)
      ];
    },
    signature: { page: 0, box: [40, 350.5, 420, 17], dateField: "Date" }
  },

  i9: {
    key: "i9",
    who: "employee",
    title: "Form I-9",
    heading: "Employment Eligibility Verification",
    summary: "Section 1, for the Department of Homeland Security. My Home Builder completes Section 2 after seeing your documents.",
    template: "i-9.pdf",
    intro: "Complete and sign Section 1 no later than your first day of employment, but not before accepting a job offer. Within three business days after you start, bring My Home Builder original documents from the Lists of Acceptable Documents (page 2 of the form): one from List A, or one from List B and one from List C. You choose which acceptable documents to present.",
    sections: [
      {
        part: "section1",
        heading: "Section 1. Employee information and attestation",
        fields: [
          { name: "lastName", label: "Last name (family name)", type: "text", required: true, max: 60, autocomplete: "family-name" },
          { name: "firstName", label: "First name (given name)", type: "text", required: true, max: 60, autocomplete: "given-name" },
          { name: "middleInitial", label: "Middle initial (if any)", type: "text", max: 2 },
          { name: "otherLastNames", label: "Other last names used (if any)", type: "text", max: 60 },
          { name: "address", label: "Address (street number and name)", type: "text", required: true, max: 80, autocomplete: "address-line1" },
          { name: "apt", label: "Apartment number (if any)", type: "text", max: 12, autocomplete: "address-line2" },
          { name: "city", label: "City or town", type: "text", required: true, max: 60, autocomplete: "address-level2" },
          { name: "state", label: "State", type: "state", required: true, autocomplete: "address-level1" },
          { name: "zip", label: "ZIP code", type: "zip", required: true, autocomplete: "postal-code" },
          { name: "birthDate", label: "Date of birth", type: "date", required: true },
          { name: "ssn", label: "U.S. Social Security number", type: "ssn", hint: "Providing it is voluntary unless My Home Builder participates in E-Verify." },
          { name: "email", label: "Employee's email address (optional)", type: "email", autocomplete: "email" },
          { name: "phone", label: "Employee's telephone number (optional)", type: "phone", autocomplete: "tel" },
          {
            name: "status", label: "Check one to attest to your citizenship or immigration status", type: "choice", required: true, options: [
              ["citizen", "1. A citizen of the United States"],
              ["national", "2. A noncitizen national of the United States"],
              ["resident", "3. A lawful permanent resident"],
              ["authorized", "4. A noncitizen authorized to work"]
            ]
          },
          { name: "residentNumber", label: "If 3: USCIS or A-Number", type: "text", max: 20 },
          { name: "authorizedUntil", label: "If 4: authorized to work until (expiration date, if any)", type: "date" },
          { name: "uscisNumber", label: "If 4, enter one of these: USCIS A-Number", type: "text", max: 20 },
          { name: "i94Number", label: "Or Form I-94 admission number", type: "text", max: 20 },
          { name: "passport", label: "Or foreign passport number and country of issuance", type: "text", max: 60 }
        ]
      },
      {
        part: "section2",
        heading: "Section 2. Employer review and verification",
        hint: "Physically examine, within three business days after the first day of employment, one List A document, or one List B and one List C document. Enter what you saw.",
        fields: [
          { name: "listA1Title", label: "List A: document title", type: "text", max: 60 },
          { name: "listA1Authority", label: "List A: issuing authority", type: "text", max: 60 },
          { name: "listA1Number", label: "List A: document number (if any)", type: "text", max: 40 },
          { name: "listA1Expires", label: "List A: expiration date (if any)", type: "date" },
          { name: "listA2Title", label: "List A document 2: title (if any)", type: "text", max: 60 },
          { name: "listA2Authority", label: "List A document 2: issuing authority", type: "text", max: 60 },
          { name: "listA2Number", label: "List A document 2: number (if any)", type: "text", max: 40 },
          { name: "listA2Expires", label: "List A document 2: expiration date (if any)", type: "date" },
          { name: "listBTitle", label: "List B: document title", type: "text", max: 60 },
          { name: "listBAuthority", label: "List B: issuing authority", type: "text", max: 60 },
          { name: "listBNumber", label: "List B: document number (if any)", type: "text", max: 40 },
          { name: "listBExpires", label: "List B: expiration date (if any)", type: "date" },
          { name: "listCTitle", label: "List C: document title", type: "text", max: 60 },
          { name: "listCAuthority", label: "List C: issuing authority", type: "text", max: 60 },
          { name: "listCNumber", label: "List C: document number (if any)", type: "text", max: 40 },
          { name: "listCExpires", label: "List C: expiration date (if any)", type: "date" },
          { name: "additionalInfo", label: "Additional information (if any)", type: "text", max: 300 },
          { name: "alternativeProcedure", label: "I used an alternative procedure authorized by DHS to examine documents.", type: "check" },
          { name: "firstDay", label: "Employee's first day of employment", type: "date", required: true },
          { name: "employerSigner", label: "Last name, first name and title of employer or authorized representative", type: "text", required: true, max: 80 }
        ]
      }
    ],
    check(values, { section }) {
      if (section === "section1") {
        if (values.status === "resident" && !values.residentNumber) return "Enter your USCIS or A-Number.";
        if (values.status === "authorized" && !values.uscisNumber && !values.i94Number && !values.passport) return "Enter your USCIS A-Number, Form I-94 admission number, or foreign passport number and country.";
      }
      if (section === "section2") {
        const listA = values.listA1Title && values.listA1Authority;
        const listBC = values.listBTitle && values.listBAuthority && values.listCTitle && values.listCAuthority;
        if (!listA && !listBC) return "Enter one List A document, or one List B and one List C document, with each document's title and issuing authority.";
      }
      return "";
    },
    attestation: "I am aware that federal law provides for imprisonment and/or fines for false statements, or the use of false documents, in connection with the completion of this form. I attest, under penalty of perjury, that this information, including my selection of the box attesting to my citizenship or immigration status, is true and correct.",
    employerAttestation: "I attest, under penalty of perjury, that (1) I have examined the documentation presented by the above-named employee, (2) the above-listed documentation appears to be genuine and to relate to the employee named, and (3) to the best of my knowledge, the employee is authorized to work in the United States.",
    fill(values, { employer }) {
      const status = values.status;
      return [
        text("Last Name (Family Name)", values.lastName),
        text("First Name Given Name", values.firstName),
        text("Employee Middle Initial (if any)", values.middleInitial),
        text("Employee Other Last Names Used (if any)", values.otherLastNames || "N/A"),
        text("Address Street Number and Name", values.address),
        text("Apt Number (if any)", values.apt || "N/A"),
        text("City or Town", values.city),
        text("State", values.state),
        text("ZIP Code", values.zip),
        text("Date of Birth mmddyyyy", slashDate(values.birthDate)),
        text("US Social Security Number", digits(values.ssn), { comb: 9 }),
        text("Employees E-mail Address", values.email),
        text("Telephone Number", values.phone),
        status === "citizen" ? mark("CB_1") : null,
        status === "national" ? mark("CB_2") : null,
        status === "resident" ? mark("CB_3") : null,
        status === "authorized" ? mark("CB_4") : null,
        status === "resident" ? text("3 A lawful permanent resident Enter USCIS or ANumber", values.residentNumber) : null,
        status === "authorized" ? text("Exp Date mmddyyyy", slashDate(values.authorizedUntil) || "N/A") : null,
        status === "authorized" ? text("USCIS ANumber", values.uscisNumber) : null,
        status === "authorized" ? text("Form I94 Admission Number", values.i94Number) : null,
        status === "authorized" ? text("Foreign Passport Number and Country of IssuanceRow1", values.passport) : null,
        // Section 2, once My Home Builder has examined the documents.
        text("Document Title 1", values.listA1Title, { page: 0 }),
        text("Issuing Authority 1", values.listA1Authority),
        text("Document Number 0 (if any)", values.listA1Number),
        text("Expiration Date if any", slashDate(values.listA1Expires)),
        text("Document Title 2 If any", values.listA2Title),
        text("Issuing Authority_2", values.listA2Authority),
        text("Document Number If any_2", values.listA2Number),
        text("List A.  Document 2. Expiration Date (if any)", slashDate(values.listA2Expires)),
        text("List B Document 1 Title", values.listBTitle),
        text("List B Issuing Authority 1", values.listBAuthority),
        text("List B Document Number 1", values.listBNumber),
        text("List B Expiration Date 1", slashDate(values.listBExpires)),
        text("List C Document Title 1", values.listCTitle),
        text("List C Issuing Authority 1", values.listCAuthority),
        text("List C Document Number 1", values.listCNumber),
        text("List C Expiration Date 1", slashDate(values.listCExpires)),
        text("Additional Information", values.additionalInfo, { lines: 6 }),
        values.alternativeProcedure ? mark("CB_Alt") : null,
        text("FirstDayEmployed mmddyyyy", slashDate(values.firstDay)),
        text("Last Name First Name and Title of Employer or Authorized Representative", values.employerSigner),
        values.firstDay ? text("Employers Business or Org Name", employer.legalName) : null,
        values.firstDay ? text("Employers Business or Org Address", employerAddress(employer)) : null
      ];
    },
    signature: { page: 0, box: [44, 421, 318, 15], dateField: "Today's Date mmddyyy" },
    employerSignature: { page: 0, box: [296, 81, 188, 19], dateField: "S2 Todays Date mmddyyyy" }
  },

  w9: {
    key: "w9",
    who: "subcontractor",
    title: "Form W-9",
    heading: "Request for Taxpayer Identification Number and Certification",
    summary: "Your tax id, so My Home Builder can report what it pays you on Form 1099.",
    template: "fw9.pdf",
    intro: "Give Form W-9 to My Home Builder; do not send it to the IRS. For guidance, see the instructions at www.irs.gov/FormW9.",
    sections: [
      {
        heading: "Your business",
        fields: [
          { name: "name", label: "1. Name of entity/individual", type: "text", required: true, max: 80, hint: "For a sole proprietor or disregarded entity, enter the owner's name here and the business name on line 2." },
          { name: "businessName", label: "2. Business name/disregarded entity name, if different from above", type: "text", max: 80 },
          {
            name: "taxClass", label: "3a. Federal tax classification", type: "choice", required: true, options: [
              ["individual", "Individual/sole proprietor"],
              ["c-corp", "C corporation"],
              ["s-corp", "S corporation"],
              ["partnership", "Partnership"],
              ["trust", "Trust/estate"],
              ["llc", "LLC"],
              ["other", "Other (see instructions)"]
            ]
          },
          { name: "llcClass", label: "If LLC: tax classification (C = C corporation, S = S corporation, P = Partnership)", type: "choice", options: [["C", "C"], ["S", "S"], ["P", "P"]] },
          { name: "otherClass", label: "If Other: describe", type: "text", max: 40 },
          { name: "foreignPartners", label: "3b. I checked Partnership or Trust/estate, or LLC with P, and have foreign partners, owners, or beneficiaries.", type: "check" },
          { name: "exemptPayee", label: "4. Exempt payee code (if any)", type: "text", max: 4 },
          { name: "fatcaCode", label: "Exemption from FATCA reporting code (if any)", type: "text", max: 4 },
          { name: "address", label: "5. Address (number, street, and apt. or suite no.)", type: "text", required: true, max: 80, autocomplete: "street-address" },
          { name: "cityStateZip", label: "6. City, state, and ZIP code", type: "text", required: true, max: 80 }
        ]
      },
      {
        heading: "Part I. Taxpayer identification number (TIN)",
        hint: "Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1 to avoid backup withholding.",
        fields: [
          { name: "tinType", label: "Type of number", type: "choice", required: true, options: [["ssn", "Social Security number"], ["ein", "Employer identification number"]] },
          { name: "tin", label: "Number", type: "text", required: true, max: 11 }
        ]
      }
    ],
    check(values) {
      if (values.taxClass === "llc" && !values.llcClass) return "Choose the LLC's tax classification (C, S or P).";
      if (values.taxClass === "other" && !values.otherClass) return "Describe the tax classification for Other.";
      if (!/^\d{9}$/u.test(digits(values.tin))) return `Enter a 9-digit ${values.tinType === "ein" ? "employer identification number" : "Social Security number"}.`;
      values.tin = values.tinType === "ein" ? digits(values.tin).replace(/^(\d{2})(\d{7})$/u, "$1-$2") : digits(values.tin).replace(/^(\d{3})(\d{2})(\d{4})$/u, "$1-$2-$3");
      return "";
    },
    attestation: "Under penalties of perjury, I certify that: 1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and 2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and 3. I am a U.S. citizen or other U.S. person (defined in the instructions); and 4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.",
    attestationNote: "If the IRS has notified you that you are currently subject to backup withholding because you have failed to report all interest and dividends on your tax return, cross out item 2 by telling My Home Builder before you sign.",
    fill(values, { employer }) {
      const prefix = "topmostSubform[0].Page1[0].";
      const box = `${prefix}Boxes3a-b_ReadOrder[0].`;
      const classIndex = { individual: 0, "c-corp": 1, "s-corp": 2, partnership: 3, trust: 4, llc: 5, other: 6 }[values.taxClass];
      const tin = digits(values.tin);
      return [
        text(`${prefix}f1_01[0]`, values.name),
        text(`${prefix}f1_02[0]`, values.businessName),
        mark(`${box}c1_1[${classIndex}]`),
        values.taxClass === "llc" ? text(`${box}f1_03[0]`, values.llcClass) : null,
        values.taxClass === "other" ? text(`${box}f1_04[0]`, values.otherClass) : null,
        values.foreignPartners ? mark(`${box}c1_2[0]`) : null,
        text(`${prefix}f1_05[0]`, values.exemptPayee),
        text(`${prefix}f1_06[0]`, values.fatcaCode),
        text(`${prefix}Address_ReadOrder[0].f1_07[0]`, values.address),
        text(`${prefix}Address_ReadOrder[0].f1_08[0]`, values.cityStateZip),
        text(`${prefix}f1_09[0]`, [employer.legalName, employer.street, cityLine(employer)].filter(Boolean).join("\n"), { lines: 3 }),
        values.tinType === "ssn" ? text(`${prefix}f1_11[0]`, tin.slice(0, 3), { comb: 3 }) : null,
        values.tinType === "ssn" ? text(`${prefix}f1_12[0]`, tin.slice(3, 5), { comb: 2 }) : null,
        values.tinType === "ssn" ? text(`${prefix}f1_13[0]`, tin.slice(5), { comb: 4 }) : null,
        values.tinType === "ein" ? text(`${prefix}f1_14[0]`, tin.slice(0, 2), { comb: 2 }) : null,
        values.tinType === "ein" ? text(`${prefix}f1_15[0]`, tin.slice(2), { comb: 7 }) : null
      ];
    },
    signature: { page: 0, box: [122, 196, 250, 17], date: [410, 199] }
  },

  deposit: {
    key: "deposit",
    who: "employee",
    title: "Direct deposit",
    heading: "Direct Deposit Authorization",
    summary: "Where your pay is deposited (optional).",
    optional: true,
    intro: "To have your pay deposited into your bank account, enter the account below. The routing and account numbers are printed at the bottom of a check; your bank can also give them to you.",
    sections: [
      {
        heading: "Your account",
        fields: [
          { name: "name", label: "Your name", type: "text", required: true, max: 80, autocomplete: "name" },
          { name: "bank", label: "Bank or credit union", type: "text", required: true, max: 80 },
          { name: "routing", label: "Routing number (9 digits)", type: "routing", required: true },
          { name: "account", label: "Account number", type: "account", required: true },
          { name: "accountType", label: "Account type", type: "choice", required: true, options: [["checking", "Checking"], ["savings", "Savings"]] }
        ]
      }
    ],
    attestation: "I authorize My Home Builder LLC to deposit my pay into the account above, and, if an amount is deposited in error, to reverse it. This authorization stays in effect until I give My Home Builder LLC written notice to change or cancel it, in time for it to act on the notice."
  }
};

// Paperwork each kind of worker is asked for, in order. Subcontractors also upload a certificate
// of insurance (a document, not a form).
export const PAPERWORK = {
  employee: ["w4", "miw4", "i9", "deposit"],
  subcontractor: ["w9"]
};

export function cityLine(employer) {
  return [[employer.city, employer.state].filter(Boolean).join(", "), employer.zip].filter(Boolean).join(" ");
}

export function employerAddress(employer) {
  return [employer.street, cityLine(employer)].filter(Boolean).join(", ");
}

// ---------- Filling the official PDFs ----------

const templates = new Map();
async function template(name) {
  if (!templates.has(name)) templates.set(name, await readFile(`${FORMS_DIR}${name}`));
  return templates.get(name);
}

function widgetPage(pdf, widget) {
  const pages = pdf.getPages();
  const ref = pdf.context.getObjectRef(widget.dict);
  if (ref) {
    const page = pdf.findPageForAnnotationRef(ref);
    if (page) return page;
  }
  const parent = widget.P();
  return pages.find((page) => page.ref === parent) || pages[0];
}

// Fits text inside a box: one line shrunk to fit (down to 6 pt), or wrapped over `lines`.
function drawInBox(page, font, value, rect, { lines = 1, comb = 0, align = "left" } = {}) {
  const { x, y, width, height } = rect;
  if (comb) {
    const size = Math.min(10, height * 0.75);
    const cell = width / comb;
    [...value].slice(0, comb).forEach((character, index) => {
      const w = font.widthOfTextAtSize(character, size);
      page.drawText(character, { x: x + cell * index + (cell - w) / 2, y: y + (height - size * 0.7) / 2, size, font, color: INK });
    });
    return;
  }
  if (lines > 1) {
    const size = Math.min(9, height / lines - 1);
    const rows = [];
    for (const paragraph of String(value).split("\n")) {
      let row = "";
      for (const word of paragraph.split(/\s+/u)) {
        const next = row ? `${row} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width - 4 && row) {
          rows.push(row);
          row = word;
        } else row = next;
      }
      rows.push(row);
    }
    rows.slice(0, lines).forEach((row, index) => {
      page.drawText(row, { x: x + 2, y: y + height - (index + 1) * (size + 1) + 1, size, font, color: INK });
    });
    return;
  }
  let size = Math.min(10, height * 0.72);
  while (size > 6 && font.widthOfTextAtSize(value, size) > width - 4) size -= 0.5;
  const w = font.widthOfTextAtSize(value, size);
  const left = align === "right" ? x + width - w - 3 : x + 2;
  page.drawText(value, { x: left, y: y + (height - size * 0.7) / 2, size, font, color: INK });
}

async function placeSignature(pdf, page, fonts, { box, date, dateField }, signer, form) {
  const [x, y, width, height] = box;
  if (signer.image) {
    const image = await pdf.embedPng(signer.image);
    const scale = Math.min(width / image.width, (height + 6) / image.height);
    page.drawImage(image, { x, y: y - 2, width: image.width * scale, height: image.height * scale });
  } else {
    let size = Math.min(16, height);
    while (size > 8 && fonts.script.widthOfTextAtSize(signer.name, size) > width) size -= 1;
    page.drawText(signer.name, { x: x + 2, y: y + 3, size, font: fonts.script, color: INK });
  }
  const when = slashDate(signer.signedOn);
  if (date) page.drawText(when, { x: date[0], y: date[1], size: 10, font: fonts.regular, color: INK });
  if (dateField) {
    const widget = form.getField(dateField).acroField.getWidgets()[0];
    drawInBox(widgetPage(pdf, widget), fonts.regular, when, widget.getRectangle());
  }
}

// The answers are drawn on the page, so the form's fields (which would sit on top of them, empty)
// are removed: every widget annotation, and the form itself.
function stripFields(pdf) {
  const widget = PDFName.of("Widget");
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = [];
    for (let index = 0; index < annots.size(); index += 1) {
      const ref = annots.get(index);
      if (pdf.context.lookup(ref)?.get(PDFName.of("Subtype")) !== widget) keep.push(ref);
    }
    page.node.set(PDFName.of("Annots"), pdf.context.obj(keep));
  }
  pdf.catalog.delete(PDFName.of("AcroForm"));
}

// The official form filled with `values` and signed. `signer` is { name, image (PNG bytes or
// null), signedOn (YYYY-MM-DD) }; `employerSigner` signs Section 2 of the I-9.
export async function fillOfficialForm(key, values, { employer, worker, signer, employerSigner = null }) {
  const spec = FORMS[key];
  const pdf = await PDFDocument.load(await template(spec.template), { ignoreEncryption: true });
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    script: await pdf.embedFont(StandardFonts.HelveticaOblique)
  };
  const form = pdf.getForm();
  for (const entry of spec.fill(values, { employer, worker }).filter(Boolean)) {
    let field;
    try {
      field = form.getField(entry.field);
    } catch {
      throw new Error(`${spec.title}: the field ${entry.field} is not on the form`);
    }
    const widgets = field.acroField.getWidgets();
    const widget = entry.page === undefined
      ? widgets[entry.widget || 0]
      : widgets.find((candidate) => pdf.getPages().indexOf(widgetPage(pdf, candidate)) === entry.page) || widgets[0];
    const page = widgetPage(pdf, widget);
    const rect = widget.getRectangle();
    if (entry.check) {
      const size = Math.max(7, Math.min(rect.height, rect.width) + 1);
      const w = fonts.bold.widthOfTextAtSize("X", size);
      page.drawText("X", { x: rect.x + (rect.width - w) / 2, y: rect.y + (rect.height - size * 0.7) / 2, size, font: fonts.bold, color: INK });
    } else {
      drawInBox(page, fonts.regular, entry.text, rect, entry);
    }
  }
  const pages = pdf.getPages();
  if (signer) await placeSignature(pdf, pages[spec.signature.page], fonts, spec.signature, signer, form);
  if (employerSigner && spec.employerSignature) await placeSignature(pdf, pages[spec.employerSignature.page], fonts, spec.employerSignature, employerSigner, form);
  stripFields(pdf);
  pdf.setTitle(`${spec.title} · ${spec.heading}`);
  pdf.setProducer("My Home Builder client portal");
  return pdf.save();
}

// ---------- Forms typeset here ----------

// Lays out paragraphs of runs ({ text, fill }) on Letter pages, underlining filled-in answers.
// Returns the y position below the last line.
export function writeParagraphs(page, fonts, paragraphs, { x = 60, y, width = 492, size = 11, leading = 16 } = {}) {
  let cursor = y;
  for (const paragraph of paragraphs) {
    const runs = typeof paragraph === "string" ? [{ text: paragraph }] : paragraph;
    const words = [];
    for (const run of runs) {
      const font = run.bold ? fonts.bold : run.fill ? fonts.regular : fonts.regular;
      for (const [index, word] of String(run.text).split(/(\s+)/u).entries()) {
        if (!word) continue;
        words.push({ text: word, font, fill: Boolean(run.fill), space: index % 2 === 1 });
      }
    }
    let line = [];
    let lineWidth = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      let left = x;
      for (const word of line) {
        const w = word.font.widthOfTextAtSize(word.space ? " " : word.text, size);
        if (!word.space) page.drawText(word.text, { x: left, y: cursor, size, font: word.font, color: INK });
        if (word.fill) page.drawLine({ start: { x: left, y: cursor - 2 }, end: { x: left + w, y: cursor - 2 }, thickness: 0.6, color: INK });
        left += w;
      }
      cursor -= leading;
      line = [];
      lineWidth = 0;
    };
    for (const word of words) {
      const w = word.font.widthOfTextAtSize(word.space ? " " : word.text, size);
      if (!word.space && lineWidth + w > width && line.length) flush();
      if (word.space && !line.length) continue;
      line.push(word);
      lineWidth += w;
    }
    if (line.length) flush();
    cursor -= leading * 0.5;
  }
  return cursor;
}

export async function typesetDeposit(values, { signer, employer }) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    script: await pdf.embedFont(StandardFonts.HelveticaOblique)
  };
  const page = pdf.addPage([612, 792]);
  page.drawText("DIRECT DEPOSIT AUTHORIZATION", { x: 60, y: 720, size: 16, font: fonts.bold, color: INK });
  page.drawText(employer.legalName || "My Home Builder LLC", { x: 60, y: 700, size: 10, font: fonts.regular, color: INK });
  let y = writeParagraphs(page, fonts, [
    [{ text: "Employee: " }, { text: values.name, fill: true }],
    [{ text: "Bank or credit union: " }, { text: values.bank, fill: true }],
    [{ text: "Routing number: " }, { text: values.routing, fill: true }],
    [{ text: "Account number: " }, { text: values.account, fill: true }],
    [{ text: "Account type: " }, { text: values.accountType === "savings" ? "Savings" : "Checking", fill: true }],
    FORMS.deposit.attestation
  ], { y: 660 });
  y -= 30;
  await placeSignature(pdf, page, fonts, { box: [60, y, 300, 22], date: [400, y + 4] }, signer, null);
  page.drawLine({ start: { x: 60, y: y - 4 }, end: { x: 360, y: y - 4 }, thickness: 0.6, color: INK });
  page.drawLine({ start: { x: 400, y: y - 4 }, end: { x: 552, y: y - 4 }, thickness: 0.6, color: INK });
  page.drawText("Employee's signature", { x: 60, y: y - 16, size: 8, font: fonts.regular, color: INK });
  page.drawText("Date", { x: 400, y: y - 16, size: 8, font: fonts.regular, color: INK });
  pdf.setTitle("Direct Deposit Authorization");
  return pdf.save();
}
