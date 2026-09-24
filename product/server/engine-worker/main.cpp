/*
 * Minimal Quackle NDJSON worker for the product-native boundary.
 *
 * This process owns one immutable Quackle configuration and handles one
 * request at a time. Diagnostics stay on stderr; stdout is protocol-only.
 */

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QTextStream>
#include <QSet>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

#include "classic_board.h"
#include "datamanager.h"
#include "game.h"
#include "generator.h"
#include "lexiconparameters.h"
#include "quackleio/flexiblealphabet.h"
#include "quackleio/util.h"
#include "resolvent.h"
#include "strategyparameters.h"

namespace {

constexpr int kProtocolVersion = 1;
constexpr int kBoardSize = 15;
constexpr int kRackSize = 7;

std::mutex protocolMutex;

class WorkerError final : public std::runtime_error {
public:
    WorkerError(QString code, QString message, bool retryable = false,
                QJsonObject details = {})
        : std::runtime_error(message.toStdString()),
          code_(std::move(code)), message_(std::move(message)),
          retryable_(retryable), details_(std::move(details)) {}

    const QString &code() const { return code_; }
    const QString &message() const { return message_; }
    bool retryable() const { return retryable_; }
    const QJsonObject &details() const { return details_; }

private:
    QString code_;
    QString message_;
    bool retryable_;
    QJsonObject details_;
};

void writeEvent(const QJsonObject &event) {
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact);
    std::lock_guard<std::mutex> lock(protocolMutex);
    std::fwrite(line.constData(), 1, static_cast<size_t>(line.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

QJsonObject eventBase(const QString &id, const QString &event) {
    QJsonObject object;
    object["protocol"] = kProtocolVersion;
    object["id"] = id.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(id);
    object["event"] = event;
    return object;
}

void emitError(const QString &id, const WorkerError &error) {
    QJsonObject object = eventBase(id, "error");
    QJsonObject errorObject;
    errorObject["code"] = error.code();
    errorObject["message"] = error.message();
    errorObject["retryable"] = error.retryable();
    if (!error.details().isEmpty())
        errorObject["details"] = error.details();
    object["error"] = errorObject;
    writeEvent(object);
}

int boundedInt(const QJsonObject &object, const char *key, int minimum,
               int maximum, int defaultValue) {
    const QJsonValue value = object.value(QLatin1String(key));
    if (value.isUndefined() || value.isNull())
        return defaultValue;
    if (!value.isDouble() || value.toDouble() != value.toInteger()) {
        throw WorkerError("invalid_request",
                          QString("field '%1' must be an integer").arg(key));
    }
    const qint64 integer = value.toInteger();
    if (integer < minimum || integer > maximum) {
        throw WorkerError(
            "invalid_request",
            QString("field '%1' must be between %2 and %3").arg(key).arg(minimum).arg(maximum));
    }
    return static_cast<int>(integer);
}

QString alphabetString(const Quackle::LetterString &letters) {
    return QuackleIO::Util::letterStringToQString(letters);
}

QJsonObject issue(const QString &code, const QString &message) {
    QJsonObject object;
    object["code"] = code;
    object["message"] = message;
    return object;
}

struct PositionState {
    Quackle::Game game;
    QJsonArray issues;

    Quackle::GamePosition &position() { return game.currentPosition(); }
    const Quackle::GamePosition &position() const { return game.currentPosition(); }
};

class DeadlineDispatch final : public Quackle::ComputerDispatch {
public:
    using ProgressCallback = std::function<void(double, qint64)>;

    DeadlineDispatch(qint64 deadlineMs, ProgressCallback progressCallback)
        : deadlineMs_(deadlineMs), progressCallback_(std::move(progressCallback)) {
        timer_.start();
    }

    bool shouldAbort() override {
        if (timer_.elapsed() >= deadlineMs_)
            aborted_.store(true);
        return aborted_.load();
    }

    void signalFractionDone(double fractionDone) override {
        const double bounded = std::clamp(fractionDone, 0.0, 1.0);
        const qint64 elapsed = timer_.elapsed();
        {
            std::lock_guard<std::mutex> lock(progressMutex_);
            if (bounded < 1.0 && elapsed - lastProgressMs_ < 250 && bounded <= lastFraction_)
                return;
            lastProgressMs_ = elapsed;
            lastFraction_ = bounded;
        }
        if (progressCallback_)
            progressCallback_(bounded, elapsed);
    }

    qint64 elapsed() const { return timer_.elapsed(); }

    bool expired() const {
        return aborted_.load() || timer_.elapsed() >= deadlineMs_;
    }

private:
    QElapsedTimer timer_;
    qint64 deadlineMs_;
    ProgressCallback progressCallback_;
    std::atomic_bool aborted_{false};
    std::mutex progressMutex_;
    qint64 lastProgressMs_ = -1000;
    double lastFraction_ = -1.0;
};

class StdoutRedirect final {
public:
    StdoutRedirect() : previous_(std::cout.rdbuf(std::cerr.rdbuf())) {}
    ~StdoutRedirect() { std::cout.rdbuf(previous_); }

private:
    std::streambuf *previous_;
};

bool isSupportedLexiconId(const QString &lexiconId) {
    return lexiconId == "nwl23" || lexiconId == "csw24";
}

QString lexiconDisplayName(const QString &lexiconId) {
    return lexiconId == "csw24" ? "CSW24" : "NWL2023";
}

class Engine final {
public:
    Engine(const QString &dataDir, const QString &dawgPath,
           const QString &gaddagPath, const QString &lexiconId,
           const QString &workerKind, const QString &workerBuild)
        : dataDir_(dataDir), lexiconId_(lexiconId), workerKind_(workerKind),
          workerBuild_(workerBuild), supportsDeepAnalysis_(lexiconId == "nwl23") {
        if (!isSupportedLexiconId(lexiconId_)) {
            throw WorkerError("unsupported_lexicon",
                              QString("worker lexicon '%1' is not enabled").arg(lexiconId_));
        }
        manager_.setAppDataDirectory(dataDir.toStdString());
        manager_.setUserDataDirectory(dataDir.toStdString());
        manager_.setBackupLexicon("default_english");
        manager_.setBoardParameters(new Classic15Board());

        auto *alphabet = new QuackleIO::FlexibleAlphabetParameters();
        const QString alphabetPath = QDir(dataDir).filePath("alphabets/english.quackle_alphabet");
        if (!alphabet->load(alphabetPath)) {
            delete alphabet;
            throw WorkerError("engine_startup_failed",
                              "could not load english alphabet");
        }
        manager_.setAlphabetParameters(alphabet);

        manager_.lexiconParameters()->loadDawg(dawgPath.toStdString());
        if (!manager_.lexiconParameters()->hasDawg()) {
            throw WorkerError("engine_startup_failed",
                              QString("could not load %1 DAWG").arg(lexiconId_));
        }
        manager_.lexiconParameters()->loadGaddag(gaddagPath.toStdString());
        if (!manager_.lexiconParameters()->hasGaddag()) {
            throw WorkerError("engine_startup_failed",
                              QString("could not load matching %1 GADDAG").arg(lexiconId_));
        }
        manager_.lexiconParameters()->setLexiconName(lexiconId_.toStdString());
        manager_.strategyParameters()->initialize(lexiconId_.toStdString());
    }

    QJsonObject readyPayload() {
        QJsonObject lexicon;
        lexicon["id"] = lexiconId_;
        lexicon["display_name"] = lexiconDisplayName(lexiconId_);
        lexicon["hash"] = QString::fromStdString(
            manager_.lexiconParameters()->hashString(false));
        lexicon["short_hash"] = QString::fromStdString(
            manager_.lexiconParameters()->hashString(true));
        lexicon["copyright"] = QString::fromStdString(
            manager_.lexiconParameters()->copyrightString());

        QJsonObject strategy;
        strategy["profile"] = lexiconId_;
        strategy["superleaves"] = manager_.strategyParameters()->hasSuperleaves();
        strategy["syn2"] = manager_.strategyParameters()->hasSyn2();
        strategy["vcplace"] = manager_.strategyParameters()->hasVcPlace();
        strategy["worths"] = manager_.strategyParameters()->hasWorths();
        strategy["bogowin"] = manager_.strategyParameters()->hasBogowin();

        QJsonArray operations;
        operations.append("validate_position");
        operations.append("generate_moves");
        if (workerKind_ == "deep" && supportsDeepAnalysis_)
            operations.append("analyze");

        QJsonObject payload;
        payload["worker_kind"] = workerKind_;
        payload["worker_build"] = workerBuild_;
        payload["quackle_commit"] = "6a41f7c0b40216c611abada4be08b1920006e62c";
        payload["protocol_version"] = kProtocolVersion;
        payload["lexicon"] = lexicon;
        payload["board_id"] = "classic15";
        payload["strategy"] = strategy;
        payload["analysis_capability"] = supportsDeepAnalysis_ ? "deep" : "static_only";
        payload["threads"] = 1;
        payload["operations"] = operations;
        return payload;
    }

    PositionState parsePosition(const QJsonObject &positionObject) {
        const QString version = positionObject.value("version").toVariant().toString();
        if (!version.isEmpty() && version != "1") {
            throw WorkerError("unsupported_position_version",
                              "position.version must be 1");
        }
        const QString lexiconId = positionObject.value("lexicon_id").toString(lexiconId_);
        if (lexiconId != lexiconId_) {
            throw WorkerError("lexicon_mismatch",
                              QString("this worker supports lexicon %1").arg(lexiconId_));
        }

        const QJsonObject boardObject = positionObject.value("board").toObject();
        if (boardObject.value("id").toString("classic15") != "classic15") {
            throw WorkerError("board_mismatch",
                              "this worker only supports board classic15");
        }
        const QJsonValue cellsValue = boardObject.value("cells");
        if (!cellsValue.isArray()) {
            throw WorkerError("invalid_position", "board.cells must be an array");
        }

        const QJsonObject players = positionObject.value("players").toObject();
        const QJsonObject onTurn = players.value("on_turn").toObject();
        const QJsonObject opponent = players.value("opponent").toObject();
        const int onTurnScore = boundedInt(onTurn, "score", 0, 100000, 0);
        const int opponentScore = boundedInt(opponent, "score", 0, 100000, 0);
        const QString rackText = positionObject.value("rack").toString().toUpper();
        if (rackText.size() > kRackSize) {
            throw WorkerError("invalid_rack", "rack cannot contain more than seven tiles");
        }

        std::string rackLeftoverStd;
        const std::string rackUtf8 = rackText.toStdString();
        const Quackle::LetterString encodedRack = manager_.alphabetParameters()->encode(
            rackUtf8, &rackLeftoverStd);
        if (!rackLeftoverStd.empty()) {
            throw WorkerError("invalid_rack", "rack contains unsupported tiles");
        }

        const bool opponentRackKnown = opponent.value("rack").isString();
        const QString opponentRackText = opponent.value("rack").toString().toUpper();
        std::string opponentLeftover;
        Quackle::LetterString encodedOpponent;
        if (opponentRackKnown) {
            if (opponentRackText.size() > kRackSize) {
                throw WorkerError("invalid_rack", "opponent rack cannot contain more than seven tiles");
            }
            encodedOpponent = manager_.alphabetParameters()->encode(
                opponentRackText.toStdString(), &opponentLeftover);
            if (!opponentLeftover.empty()) {
                throw WorkerError("invalid_rack", "opponent rack contains unsupported tiles");
            }
        }

        Quackle::PlayerList playersList;
        Quackle::Player current(MARK_UV("on-turn"), Quackle::Player::HumanPlayerType, 0);
        Quackle::Player other(MARK_UV("opponent"), Quackle::Player::HumanPlayerType, 1);
        const Quackle::LetterString dummy = manager_.alphabetParameters()->encode(
            "AAAAAAA");
        current.setRack(Quackle::Rack(dummy));
        other.setRack(Quackle::Rack(dummy));
        current.setScore(onTurnScore);
        other.setScore(opponentScore);
        playersList.push_back(current);
        playersList.push_back(other);

        PositionState state;
        state.game.setPlayers(playersList);
        state.game.addPosition();
        state.position().setCurrentPlayer(0);

        Quackle::Board board;
        board.prepareEmptyBoard();
        QSet<QString> coordinates;
        const QJsonArray cells = cellsValue.toArray();
        for (const QJsonValue &cellValue : cells) {
            if (!cellValue.isObject()) {
                throw WorkerError("invalid_position", "each board cell must be an object");
            }
            const QJsonObject cell = cellValue.toObject();
            if (!cell.contains("row") || !cell.contains("col")) {
                throw WorkerError("invalid_position", "board cells require row and col");
            }
            const int row = boundedInt(cell, "row", 0, kBoardSize - 1, 0);
            const int col = boundedInt(cell, "col", 0, kBoardSize - 1, 0);
            const QString coordinate = QString::number(row) + ":" + QString::number(col);
            if (coordinates.contains(coordinate)) {
                throw WorkerError("invalid_position", "board contains duplicate coordinates");
            }
            coordinates.insert(coordinate);

            const QString letterText = cell.value("letter").toString().toUpper();
            if (letterText.size() != 1 || letterText[0] < QChar('A') || letterText[0] > QChar('Z')) {
                throw WorkerError("invalid_position", "board cells require one ASCII letter");
            }
            std::string leftover;
            Quackle::LetterString encoded = manager_.alphabetParameters()->encode(
                letterText.toStdString(), &leftover);
            if (!leftover.empty() || encoded.size() != 1) {
                throw WorkerError("invalid_position", "board cell letter cannot be encoded");
            }
            if (cell.value("blank").toBool(false)) {
                Quackle::LetterString blankEncoded;
                blankEncoded += manager_.alphabetParameters()->setBlankness(encoded[0]);
                encoded = blankEncoded;
            }
            board.makeMove(Quackle::Move::createPlaceMove(row, col, true, encoded));
        }

        state.position().setBoard(board);
        state.position().setCurrentPlayerRack(Quackle::Rack(encodedRack), false);
        state.position().setPlayerRack(1, Quackle::Rack(encodedOpponent), false);

        Quackle::Bag bag;
        bag.prepareFullBag();
        if (!bag.removeLetters(board.tilesOnBoard().tiles()) ||
            !bag.removeLetters(encodedRack) ||
            (opponentRackKnown && !bag.removeLetters(encodedOpponent))) {
            state.issues.append(issue("tile_multiset_exceeded",
                                      "board and racks contain more tiles than a standard bag"));
        }
        state.position().setBag(bag);
        validateBoardWords(state.position(), state.issues);
        state.position().ensureBoardIsPreparedForAnalysis();
        return state;
    }

    QJsonObject validatePosition(const QJsonObject &payload) {
        const QJsonObject position = payload.value("position").toObject(payload);
        PositionState state = parsePosition(position);
        QJsonObject result;
        result["valid"] = state.issues.isEmpty();
        result["issues"] = state.issues;
        return result;
    }

    QJsonObject generateMoves(const QJsonObject &payload, quint32 seed) {
        const QJsonObject position = payload.value("position").toObject(payload);
        PositionState state = parsePosition(position);
        if (!state.issues.isEmpty()) {
            QJsonObject details;
            details["issues"] = state.issues;
            throw WorkerError("invalid_position", "position is not valid", false, details);
        }

        const QJsonObject options = payload.value("options").toObject();
        const int limit = boundedInt(options, "limit", 1, 100, 20);
        const bool includeExchanges = options.value("include_exchanges").toBool(true);
        manager_.seedRandomNumbers(seed);

        Quackle::Generator generator(state.position());
        generator.kibitz(limit, includeExchanges ? Quackle::Generator::RegularKibitz
                                                 : Quackle::Generator::CannotExchange);
        QJsonArray moves;
        for (const Quackle::Move &candidate : generator.kibitzList()) {
            Quackle::Move move = candidate;
            state.position().ensureMovePrettiness(move);
            moves.append(moveJson(move));
        }
        QJsonObject result;
        result["moves"] = moves;
        result["count"] = moves.size();
        return result;
    }

    QJsonObject analyze(const QJsonObject &payload, const QString &requestId,
                        quint32 seed, int deadlineMs) {
        if (!supportsDeepAnalysis_) {
            throw WorkerError("unsupported_operation",
                              QString("deep analysis is unavailable for lexicon %1").arg(lexiconId_));
        }
        if (workerKind_ != "deep") {
            throw WorkerError("unsupported_operation",
                              "operation 'analyze' is only available on deep workers");
        }
        const QJsonObject position = payload.value("position").toObject(payload);
        PositionState state = parsePosition(position);
        if (!state.issues.isEmpty()) {
            QJsonObject details;
            details["issues"] = state.issues;
            throw WorkerError("invalid_position", "position is not valid", false, details);
        }

        const QJsonObject options = payload.value("options").toObject();
        const int limit = boundedInt(options, "limit", 1, 50, 10);
        manager_.seedRandomNumbers(seed);

        Quackle::TwentySecondPlayer player;
        Quackle::ComputerParameters parameters = player.parameters();
        parameters.secondsPerTurn = std::max(1, (deadlineMs + 999) / 1000);
        parameters.inferring = false;
        player.setParameters(parameters);
        player.setThreadCount(1, Quackle::ThreadQoS::Balanced);
        auto emitProgress = [&requestId](double fraction, qint64 elapsedMs) {
            QJsonObject progress = eventBase(requestId, "progress");
            QJsonObject payload;
            payload["fraction"] = fraction;
            payload["elapsed_ms"] = elapsedMs;
            progress["payload"] = payload;
            writeEvent(progress);
        };
        DeadlineDispatch dispatch(deadlineMs, emitProgress);
        player.setDispatch(&dispatch);
        player.setPosition(state.position());
        emitProgress(0.0, 0);

        Quackle::MoveList candidates;
        {
            // Quackle's analysis code uses UVcout for diagnostics. Keep the
            // NDJSON stdout channel clean while preserving those diagnostics
            // on the supervisor's stderr stream.
            StdoutRedirect redirect;
            candidates = player.moves(limit);
        }
        if (dispatch.expired())
            throw WorkerError("deadline_exceeded", "native analysis exceeded its deadline", true);
        emitProgress(1.0, dispatch.elapsed());

        QJsonArray moves;
        int rank = 1;
        for (const Quackle::Move &candidate : candidates) {
            Quackle::Move move = candidate;
            state.position().ensureMovePrettiness(move);
            QJsonObject serialized = moveJson(move);
            serialized["rank"] = rank++;
            serialized["win"] = move.win;
            serialized["possible_win"] = move.possibleWin;
            moves.append(serialized);
        }

        QJsonObject result;
        result["moves"] = moves;
        result["count"] = moves.size();
        result["strategy"] = "twenty_second_championship";
        result["partial"] = false;
        return result;
    }

private:
    void validateBoardWords(const Quackle::GamePosition &position,
                            QJsonArray &issues) {
        QSet<QString> seen;
        const Quackle::Board &board = position.board();
        const auto check = [&](const Quackle::LetterString &word,
                               const QString &orientation, int row, int col) {
            if (word.size() < 2)
                return;
            const QString visible = alphabetString(word);
            if (seen.contains(orientation + ":" + QString::number(row) + ":" +
                             QString::number(col)))
                return;
            seen.insert(orientation + ":" + QString::number(row) + ":" +
                        QString::number(col));
            if (!position.isAcceptableWord(word)) {
                QJsonObject item = issue("unacceptable_word",
                                          QString("word '%1' is not in %2").arg(visible, lexiconId_));
                item["word"] = visible;
                item["orientation"] = orientation;
                item["row"] = row;
                item["col"] = col;
                issues.append(item);
            }
        };

        for (int row = 0; row < board.height(); ++row) {
            int col = 0;
            while (col < board.width()) {
                while (col < board.width() &&
                       !manager_.alphabetParameters()->isSomeLetter(board.letter(row, col)))
                    ++col;
                if (col >= board.width())
                    break;
                const int start = col;
                Quackle::LetterString word;
                while (col < board.width() &&
                       manager_.alphabetParameters()->isSomeLetter(board.letter(row, col))) {
                    word += manager_.alphabetParameters()->clearBlankness(board.letter(row, col));
                    ++col;
                }
                check(word, "horizontal", row, start);
            }
        }

        for (int col = 0; col < board.width(); ++col) {
            int row = 0;
            while (row < board.height()) {
                while (row < board.height() &&
                       !manager_.alphabetParameters()->isSomeLetter(board.letter(row, col)))
                    ++row;
                if (row >= board.height())
                    break;
                const int start = row;
                Quackle::LetterString word;
                while (row < board.height() &&
                       manager_.alphabetParameters()->isSomeLetter(board.letter(row, col))) {
                    word += manager_.alphabetParameters()->clearBlankness(board.letter(row, col));
                    ++row;
                }
                check(word, "vertical", start, col);
            }
        }
    }

    QJsonObject moveJson(const Quackle::Move &move) const {
        const QString position = QuackleIO::Util::uvStringToQString(move.positionString());
        const QString tiles = alphabetString(move.tiles());
        const QString word = alphabetString(move.wordTiles());
        const QString usedTiles = alphabetString(move.usedTiles());
        QString action = "pass";
        if (move.action == Quackle::Move::Place)
            action = "place";
        else if (move.action == Quackle::Move::Exchange ||
                 move.action == Quackle::Move::BlindExchange)
            action = "exchange";

        const QString canonical = action + "|" + position + "|" + tiles;
        const QString id = QString::fromLatin1(
            QCryptographicHash::hash(canonical.toUtf8(), QCryptographicHash::Sha256).toHex());

        QJsonObject object;
        object["id"] = id;
        object["action"] = action;
        object["position"] = position;
        object["row"] = move.startrow;
        object["col"] = move.startcol;
        object["horizontal"] = move.horizontal;
        object["tiles"] = tiles;
        object["used_tiles"] = usedTiles;
        object["word"] = word;
        object["score"] = move.score;
        object["equity"] = move.equity;
        object["is_bingo"] = move.isBingo;
        return object;
    }

    Quackle::DataManager manager_;
    QString dataDir_;
    QString lexiconId_;
    QString workerKind_;
    QString workerBuild_;
    bool supportsDeepAnalysis_;
};

void validateRequestEnvelope(const QJsonObject &request) {
    if (request.value("protocol").toInt(-1) != kProtocolVersion)
        throw WorkerError("protocol_mismatch", "unsupported worker protocol", false);
    if (!request.value("id").isString() || request.value("id").toString().isEmpty())
        throw WorkerError("invalid_request", "id must be a non-empty string");
    if (!request.value("op").isString())
        throw WorkerError("invalid_request", "op must be a string");
    const QString op = request.value("op").toString();
    if (!request.value("payload").isObject())
        throw WorkerError("invalid_request", "payload must be an object");
    if (op == "cancel") {
        if (!request.value("payload").toObject().value("target_id").isString())
            throw WorkerError("invalid_request", "cancel payload requires target_id");
        return;
    }
    boundedInt(request, "deadline_ms", 1, 60000, 1);
    const QJsonValue seed = request.value("seed");
    if (!seed.isDouble() || seed.toDouble() != seed.toInteger() ||
        seed.toInteger() < 0 || seed.toInteger() > 4294967295LL)
        throw WorkerError("invalid_request", "seed must be an unsigned 32-bit integer");
}

} // namespace

int main(int argc, char **argv) {
    QCoreApplication application(argc, argv);
    QCoreApplication::setApplicationName("quackle-engine-worker");

    QCommandLineParser parser;
    parser.setApplicationDescription("Quackle Web native NDJSON worker");
    parser.addHelpOption();
    parser.addOption({"data-dir", "Quackle data directory", "path", "/app/data"});
    parser.addOption({"dawg", "DAWG path", "path"});
    parser.addOption({"gaddag", "GADDAG path", "path"});
    parser.addOption({"lexicon-id", "Enabled lexicon ID", "id", "nwl23"});
    parser.addOption({"worker-kind", "ready event worker kind", "kind", "fast"});
    parser.addOption({"worker-build", "worker build identity", "build", "development"});
    parser.process(application);

    const QString dataDir = parser.value("data-dir");
    const QString lexiconId = parser.value("lexicon-id");
    const QString dawgPath = parser.isSet("dawg")
                                 ? parser.value("dawg")
                                 : QDir(dataDir).filePath(QString("lexica/%1.dawg").arg(lexiconId));
    const QString gaddagPath = parser.isSet("gaddag")
                                   ? parser.value("gaddag")
                                   : QDir(dataDir).filePath(QString("lexica/%1.gaddag").arg(lexiconId));

    try {
        Engine engine(dataDir, dawgPath, gaddagPath, lexiconId,
                      parser.value("worker-kind"), parser.value("worker-build"));
        QJsonObject ready = eventBase(QString(), "ready");
        ready["payload"] = engine.readyPayload();
        writeEvent(ready);

        QTextStream input(stdin);
        QString line;
        while (input.readLineInto(&line)) {
            if (line.trimmed().isEmpty())
                continue;

            QString id;
            try {
                QJsonParseError parseError;
                const QJsonDocument document = QJsonDocument::fromJson(
                    line.toUtf8(), &parseError);
                if (document.isNull() || !document.isObject()) {
                    throw WorkerError("invalid_json", parseError.errorString());
                }
                const QJsonObject request = document.object();
                id = request.value("id").toString();
                validateRequestEnvelope(request);

                QJsonObject started = eventBase(id, "started");
                QJsonObject startedPayload;
                startedPayload["op"] = request.value("op").toString();
                started["payload"] = startedPayload;
                writeEvent(started);

                QElapsedTimer timer;
                timer.start();
                const QString op = request.value("op").toString();
                const QJsonObject payload = request.value("payload").toObject();
                const quint32 seed = static_cast<quint32>(request.value("seed").toInteger());
                const int deadline = request.value("deadline_ms").toInt();

                if (op == "cancel") {
                    QJsonObject cancelled = eventBase(id, "cancelled");
                    QJsonObject cancelledPayload;
                    cancelledPayload["target_id"] = payload.value("target_id").toString();
                    cancelled["payload"] = cancelledPayload;
                    writeEvent(cancelled);
                    continue;
                }

                QJsonObject result;
                if (op == "validate_position") {
                    result = engine.validatePosition(payload);
                } else if (op == "generate_moves") {
                    result = engine.generateMoves(payload, seed);
                } else if (op == "analyze") {
                    result = engine.analyze(payload, id, seed, deadline);
                } else {
                    throw WorkerError("unsupported_operation",
                                      QString("operation '%1' is not implemented").arg(op));
                }

                if (timer.elapsed() > deadline)
                    throw WorkerError("deadline_exceeded", "native operation exceeded its deadline", true);

                QJsonObject completed = eventBase(id, "result");
                QJsonObject resultEnvelope;
                resultEnvelope["op"] = op;
                resultEnvelope["elapsed_ms"] = static_cast<qint64>(timer.elapsed());
                resultEnvelope["data"] = result;
                completed["payload"] = resultEnvelope;
                writeEvent(completed);
            } catch (const WorkerError &error) {
                emitError(id, error);
            } catch (const std::exception &error) {
                emitError(id, WorkerError("engine_error", QString::fromUtf8(error.what()), true));
            }
        }
    } catch (const WorkerError &error) {
        std::cerr << error.code().toStdString() << ": "
                  << error.message().toStdString() << std::endl;
        return 78;
    } catch (const std::exception &error) {
        std::cerr << "engine_startup_failed: " << error.what() << std::endl;
        return 78;
    }

    return 0;
}
