import { rupeesInWords } from "@/shared/invoice";
import type { Language } from "./languages";

/** Hindi has a separate word for every number up to 99, so these are lists rather than tens + ones. */
const HINDI = "शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे".split(" ");
const HINGLISH = "shunya ek do teen chaar paanch chhah saat aath nau das gyarah barah terah chaudah pandrah solah satrah atharah unnis bees ikkis bais teis chaubis pachchis chhabbis sattais atthais untis tees ikattis battis taintis chauntis paintis chhattis saintis adtis untalis chalis iktalis bayalis taintalis chaualis paintalis chhiyalis saintalis adtalis unchas pachas ikyavan bavan tirpan chauvan pachpan chhappan sattavan atthavan unsath saath iksath basath tirsath chaunsath painsath chhiyasath sadsath adsath unhattar sattar ikhattar bahattar tihattar chauhattar pachhattar chhihattar sathattar athattar unasi assi ikyasi bayasi tirasi chaurasi pachasi chhiyasi sattasi atthasi navasi nabbe ikyanve banve tiranve chauranve pachanve chhiyanve sattanve atthanve ninyanve".split(" ");

const WORDS = {
  hi: { numbers: HINDI, hundred: "सौ", thousand: "हज़ार", lakh: "लाख", crore: "करोड़", rupees: "रुपये", and: "और", paise: "पैसे", only: "मात्र" },
  hinglish: { numbers: HINGLISH, hundred: "sau", thousand: "hazaar", lakh: "lakh", crore: "crore", rupees: "rupaye", and: "aur", paise: "paise", only: "sirf" },
};

/** The bill total in words, in the person's language. English keeps the existing wording. */
export function amountInWords(paise: number, language: Language): string {
  if (language === "en") return rupeesInWords(paise);
  const { numbers, hundred, thousand, lakh, crore, rupees, and, paise: paiseWord, only } = WORDS[language];
  let rest = Math.floor(paise / 100);
  const parts: string[] = [];
  const three = (n: number) => [n >= 100 ? `${numbers[Math.floor(n / 100)]} ${hundred}` : "", n % 100 ? numbers[n % 100]! : ""].filter(Boolean).join(" ");
  for (const [size, name] of [[10000000, crore], [100000, lakh], [1000, thousand]] as const) {
    if (rest >= size) {
      parts.push(`${three(Math.floor(rest / size))} ${name}`);
      rest %= size;
    }
  }
  if (rest) parts.push(three(rest));
  const change = paise % 100;
  const whole = parts.join(" ") || numbers[0]!;
  return `${whole} ${rupees}${change ? ` ${and} ${numbers[change]} ${paiseWord}` : ""} ${only}`;
}
