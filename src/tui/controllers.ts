import type { CliRenderer } from "@opentui/core";
import { AutocompleteController } from "./autocomplete-controller.js";
import { BUILT_IN_SLASH_COMMAND_ITEMS } from "./slash-commands.js";
import { CopyController } from "./copy-controller.js";
import type { LayoutRefs } from "./layout.js";
import { PasteController } from "./paste-controller.js";
import { QuestionPicker } from "./question-picker.js";
import type { StatusController } from "./status-controller.js";
import type { TranscriptEntry } from "./transcript-log.js";
import type { TranscriptWriter } from "./transcript-writer.js";
import type { Session } from "../session/session.js";

export interface TuiControllers {
  autocomplete: AutocompleteController;
  questionPicker: QuestionPicker;
  pasteController: PasteController;
  copyController: CopyController;
}

export interface TuiControllerDeps {
  renderer: CliRenderer;
  ui: LayoutRefs;
  session: Session;
  sessionId: string;
  workDir: string;
  transcriptWriter: TranscriptWriter;
  statusController: StatusController;
  appendBlock(label: string | null, body: string, fg: string): void;
  appendUserBlock(message: string): void;
  recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void;
  reportError(error: unknown): void;
  onPickerEscapeClose(): void;
  getLastSelectionText(): string;
  clearLastSelectionText(): void;
}

/**
 * Bundles the four secondary input controllers that `runTui` wires onto the
 * composer. Kept together because they all share the same layout handles and
 * status/writer pair; building them in one place keeps `runTui` short and
 * makes the controller surface easy to mock in isolation.
 */
export function createTuiControllers(deps: TuiControllerDeps): TuiControllers {
  // Track an in-flight reload so rapid `/` openings collapse into a
  // single discovery pass. Stays scoped to this controller bundle so the
  // closure resets when the session is torn down and recreated.
  let pendingSkillReload: Promise<void> | undefined;
  const autocomplete: AutocompleteController = new AutocompleteController({
    inputField: deps.ui.inputField,
    skillAutocompletePanel: deps.ui.skillAutocompletePanel,
    commandRows: deps.ui.commandRows,
    commandHeader: deps.ui.commandHeader,
    skillRows: deps.ui.skillRows,
    skillHeader: deps.ui.skillHeader,
    fileAutocompletePanel: deps.ui.fileAutocompletePanel,
    fileAutocompleteRows: deps.ui.fileAutocompleteRows,
    workDir: deps.workDir,
    onEscapeClose: deps.onPickerEscapeClose,
    onSkillTokenOpened: () => {
      if (pendingSkillReload) return;
      pendingSkillReload = (async () => {
        try {
          const skills = await deps.session.reloadSkills();
          autocomplete.setSkillItems([
            ...BUILT_IN_SLASH_COMMAND_ITEMS,
            ...skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              path: skill.baseDir,
              group: "skills" as const,
            })),
          ]);
          // Re-evaluate against the current token so the open picker
          // picks up the freshly discovered entries.
          autocomplete.refresh();
        } catch (error) {
          deps.reportError(error);
        } finally {
          pendingSkillReload = undefined;
        }
      })();
    },
  });

  const questionPicker = new QuestionPicker({
    questionPanel: deps.ui.questionPanel,
    questionTitle: deps.ui.questionTitle,
    questionRows: deps.ui.questionRows,
    inputField: deps.ui.inputField,
    session: deps.session,
    onEscapeClose: deps.onPickerEscapeClose,
    appendUserBlock: deps.appendUserBlock,
    reportError: deps.reportError,
    markRunning: () => deps.statusController.markRunning(),
    isRunning: () => deps.statusController.isRunning(),
  });

  const pasteController = new PasteController({
    inputField: deps.ui.inputField,
    sessionId: deps.sessionId,
    workDir: deps.workDir,
    appendBlock: deps.appendBlock,
    statusController: deps.statusController,
  });

  const copyController = new CopyController({
    renderer: deps.renderer,
    transcriptWriter: deps.transcriptWriter,
    statusController: deps.statusController,
    getLastSelectionText: deps.getLastSelectionText,
    clearLastSelectionText: deps.clearLastSelectionText,
  });

  return { autocomplete, questionPicker, pasteController, copyController };
}
