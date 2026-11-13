/**
 * Static container for note display constants used in canvas rendering.
 * States are light overlays: the slate zone surfaces are too dark for darkening ones.
 */
export class NoteDisplay {
  static readonly fill = 'rgba(255,255,255,1)';
  static readonly fillSeq = 'rgba(255,255,255,.45)';
  static readonly fillSeqBlack = 'rgba(255,255,255,.45)';
  static readonly fillArp = 'rgba(255,255,255,.28)';
  static readonly fillArpBlack = 'rgba(255,255,255,.28)';
  static readonly fillArpPlayed = 'rgba(255,255,196,1)';
  static readonly fillBlack = 'rgba(255,255,255,1)';
  static readonly fillSustain = 'rgba(255,255,255,.5)';
  static readonly fillOctaveLabel = 'rgba(255,255,255,0.2)';
  // MPE: held keys dimmer, so the dots over them read
  static readonly fillMpeKey = 'rgba(255,255,255,.3)';
  static readonly fillMpeDot = 'rgba(255,255,255,1)';
  static readonly strokeMpeDot = 'rgba(0,0,0,.6)';
  // the 128 key outlines are a ruler, not content: low contrast, so a played range reads
  static readonly fillHintWhite = 'rgba(255,255,255,0.06)';
  static readonly fillHintBlack = 'rgba(0,0,0,0.22)';
  static readonly top = 0;
  static readonly height = 16;
  static readonly heightBlack = 12;
}
