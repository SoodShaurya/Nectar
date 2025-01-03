const { manager } = require("./manager");
const { groupmanager } = require("./groupmanager");
const { taskmanager, changetask } = require("./statemachine");


module.exports = {
    manager,
    groupmanager,
    taskmanager,
    changetask,
};
