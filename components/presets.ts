// The two frozen development cases (Task/evidence/T04-cases.md). Hypothetical scenarios with public artists;
// they do not claim any artist's availability, fee or willingness.
export interface Preset {
  id: string;
  label: string;
  headliner: string;
  references: string[];
  shortlist: string[];
  question: string;
}

export const PRESETS: Preset[] = [
  {
    id: "D1",
    label: "Phoebe Bridgers → Olivia Rodrigo fans",
    headliner: "Phoebe Bridgers",
    references: ["Olivia Rodrigo"],
    shortlist: ["Lucy Dacus", "Julien Baker", "Soccer Mommy", "Clairo", "Gracie Abrams"],
    question:
      "We want to reach younger, more pop-leaning listeners on this tour. Who on this list comes closest to Olivia Rodrigo's audience without clearly sacrificing the headliner's current fans, and what supports each side?",
  },
  {
    id: "D2",
    label: "Khruangbin → psych / bedroom-pop fans",
    headliner: "Khruangbin",
    references: ["Tame Impala", "Mac DeMarco", "Unknown Mortal Orchestra"],
    shortlist: ["Men I Trust", "Bahamas", "Hermanos Gutiérrez", "Parcels", "Thee Sacred Souls", "Glass Beams", "Altın Gün", "L'Impératrice", "Crumb", "Babe Rainbow"],
    question:
      "We want to connect Khruangbin's instrumental-groove listeners with psych-rock and bedroom-pop listeners. Who on this list does not lose either side?",
  },
];
