// An incremental parser for a text/event-stream body read with fetch (EventSource cannot send the access
// key header, and the key never goes in a URL). Text arrives in chunks that may split a line, or a CRLF
// pair, anywhere; the parser keeps the unfinished part until the rest arrives. Pure: no DOM access.
export function createEventStreamParser() {
    let buffer = '';
    let eventName = '';
    let dataLines = [];
    let hasData = false;
    const takeLine = (line, done) => {
        if (line === '') {
            // A blank line ends an event; one without data is dropped, as the specification says.
            if (hasData)
                done.push({ event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') });
            eventName = '';
            dataLines = [];
            hasData = false;
            return;
        }
        if (line.startsWith(':'))
            return; // A comment, used as a keep-alive.
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1);
        if (field === 'event')
            eventName = value;
        else if (field === 'data') {
            dataLines.push(value);
            hasData = true;
        }
        // id and retry are not used: the dashboard reconnects on its own schedule and needs no replay.
    };
    // A CR ends a line on its own; when it was the last character of a chunk, an LF that starts the next
    // chunk is the second half of the same CRLF and is skipped.
    let skipLeadingLf = false;
    return {
        push(chunk) {
            buffer += chunk;
            if (skipLeadingLf && buffer !== '') {
                if (buffer.startsWith('\n'))
                    buffer = buffer.slice(1);
                skipLeadingLf = false;
            }
            const done = [];
            let start = 0;
            for (;;) {
                const lf = buffer.indexOf('\n', start);
                const cr = buffer.indexOf('\r', start);
                let end;
                let next;
                if (cr !== -1 && (lf === -1 || cr < lf)) {
                    end = cr;
                    if (cr === buffer.length - 1) {
                        next = cr + 1;
                        skipLeadingLf = true;
                    }
                    else {
                        next = buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
                    }
                }
                else if (lf !== -1) {
                    end = lf;
                    next = lf + 1;
                }
                else {
                    break;
                }
                takeLine(buffer.slice(start, end), done);
                start = next;
            }
            buffer = buffer.slice(start);
            return done;
        },
    };
}
