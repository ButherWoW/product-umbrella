// Imported first by server.js so that messages printed while other modules load (e.g. db.js) reach LOG_FILE too.
import { installLogFile } from './log-file.js';

installLogFile();
